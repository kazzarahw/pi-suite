import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, fakeCtx, type FakeApi } from "../../shared/test/harness.ts";
import { saveConfig, DEFAULTS, type GoalConfig } from "../src/config.ts";
import type { Goal } from "../src/state.ts";

/**
 * pi-goal's wiring: one tool, one command, and the hooks that keep the objective in
 * front of the agent. Every test runs against a temp agent directory so the real
 * `~/.pi/agent/pi-goal.json` is never read or written.
 */
function withConfig<T>(cfg: Partial<GoalConfig>, fn: (api: FakeApi) => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-goal-wiring-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  saveConfig({ ...DEFAULTS, ...cfg });
  return loadExtension("goal")
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      rmSync(agentDir, { recursive: true, force: true });
    });
}

const set = (api: FakeApi, params: Record<string, unknown>, ctx = fakeCtx()) =>
  api.tools.get("goal_set")!.execute("c1", params as never, undefined, undefined, ctx);

const branchWith = (goal: Goal | null) => [
  { type: "custom", customType: "goal-state", data: { goal } },
];

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

test("goal registers goal_set and /pi-goal", async () => {
  const api = await loadExtension("goal");
  expect([...api.tools.keys()]).toEqual(["goal_set"]);
  expect([...api.commands.keys()]).toEqual(["pi-goal"]);
});

test("goal subscribes the context, turn, session and settle hooks", async () => {
  const api = await loadExtension("goal");
  for (const hook of ["context", "turn_end", "session_start", "session_compact", "agent_settled"]) {
    expect(api.subscribes(hook)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Standing context — the reason the extension exists.
// ---------------------------------------------------------------------------

test("the objective is injected into every LLM call", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await set(api, { objective: "ship the auth refactor" });
    const result = (await api.fire("context", { messages: [{ role: "user", content: "hi" }] })) as {
      messages: Array<{ content: string }>;
    };
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.content).toContain("<pi-goal>");
    expect(result.messages[0]!.content).toContain("ship the auth refactor");
    // Prepended, so the original turn still reads last.
    expect(result.messages[1]!.content).toBe("hi");
  });
});

test("nothing is injected before an objective is set", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    expect(await api.fire("context", { messages: [] })).toBeUndefined();
  });
});

test("a met objective stops being injected", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await set(api, { objective: "ship it" });
    await set(api, { objective: "ship it", status: "met" });
    expect(await api.fire("context", { messages: [] })).toBeUndefined();
  });
});

test("the injection works without a UI", async () => {
  // The whole reason this is a `context` hook and not a queued message: returning
  // messages cannot stall `pi -p` waiting for a next prompt that never comes.
  await withConfig({ mode: "notify" }, async (api) => {
    await set(api, { objective: "ship it" }, fakeCtx({ hasUI: false }));
    const result = await api.fire("context", { messages: [] }, fakeCtx({ hasUI: false }));
    expect(result).toBeDefined();
    expect(api.messages).toEqual([]);
  });
});

// THE prompt-cache guard, at the wiring level. The block lands at message index 0 of
// every call and the provider caches the conversation prefix, so it has to be stable for
// as long as the objective is. Turn count and todo tally go to the widget instead.
test("the injected block is byte-identical across turns and todo movement", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await set(api, { objective: "ship it" }, ctx);
    const inject = async () =>
      (
        (await api.fire("context", { messages: [] })) as { messages: Array<{ content: string }> }
      ).messages[0]!.content;

    const first = await inject();
    await api.fire("turn_end", {}, ctx);
    api.emitBus("todo:updated", { todos: [{ id: "1", content: "a", status: "done" }] });
    await api.fire("turn_end", {}, ctx);
    expect(await inject()).toBe(first);
    expect(first).not.toContain("turn");
    expect(first).not.toContain("todos");
  });
});

test("the widget reports how long the objective has stood, and keeps up", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await set(api, { objective: "ship it" }, ctx);
    await api.fire("turn_end", {}, ctx);
    await api.fire("turn_end", {}, ctx);
    // Repainted on turn_end — without that the count would be reset-then-shown at every
    // paint site and could never display anything but zero.
    expect(ctx.uiCalls.widgets.at(-1)!.lines).toEqual(["▸ ship it", "  2 turns"]);
  });
});

test("setting a new objective restarts the turn count", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await set(api, { objective: "first" }, ctx);
    await api.fire("turn_end", {}, ctx);
    await api.fire("turn_end", {}, ctx);
    await set(api, { objective: "second" }, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines).toEqual(["▸ second"]);
  });
});

test("turn_end does nothing before an objective is set", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await api.fire("turn_end", {}, ctx);
    expect(ctx.uiCalls.widgets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mode: off — the no-op contract.
// ---------------------------------------------------------------------------

test("mode:off suppresses the injection and the nudge, but not the tool or the widget", async () => {
  await withConfig({ mode: "off" }, async (api) => {
    const ctx = fakeCtx();
    // The tool still works, so the objective is there when the dial is turned back up,
    // and the widget still echoes it — same as pi-todo, whose `off` is "widget only".
    // The widget is a tool result, not automatic behaviour.
    await set(api, { objective: "ship it" }, ctx);
    expect(ctx.uiCalls.widgets.some((w) => w.id === "goal")).toBe(true);

    expect(await api.fire("context", { messages: [] })).toBeUndefined();
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toEqual([]);

    // But nothing paints on its own: a widget echoing a tool result is fine in `off`,
    // while one this hook animates every turn would be exactly the automatic behaviour
    // `off` exists to stop.
    const quiet = fakeCtx();
    for (let i = 0; i < 5; i++) await api.fire("turn_end", {}, quiet);
    expect(quiet.uiCalls.widgets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Settle.
// ---------------------------------------------------------------------------

test("notify reminds on settle while the objective is open", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await set(api, { objective: "ship it" });
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(1);
    expect(JSON.stringify(api.messages[0])).toContain("ship it");
    expect((api.messages[0]!.options as { deliverAs: string }).deliverAs).toBe("nextTurn");
  });
});

test("no settle nudge without an interactive UI (print/JSON mode)", async () => {
  // The print-mode hang: a queued message stalls Pi's exit waiting for a next prompt.
  await withConfig({ mode: "block" }, async (api) => {
    await set(api, { objective: "ship it" }, fakeCtx({ hasUI: false }));
    await api.fire("agent_settled", {}, fakeCtx({ hasUI: false }));
    expect(api.messages).toEqual([]);
  });
});

test("no settle nudge once the objective is met", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await set(api, { objective: "ship it", status: "met" });
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toEqual([]);
  });
});

test("block auto-continues, and stops at the per-objective quota", async () => {
  await withConfig({ mode: "block", maxNudges: 2 }, async (api) => {
    await set(api, { objective: "ship it" });
    for (let i = 0; i < 5; i++) await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(2);
    expect((api.messages[0]!.options as { triggerTurn: boolean }).triggerTurn).toBe(true);
  });
});

test("the auto-continue limit is read from config per settle, not at load", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    await set(api, { objective: "ship it" });
    for (let i = 0; i < 3; i++) await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(1);
  });
});

// THE termination guard. The signature is pi-goal's own state and nothing else: folding
// a peer's `todo:updated` state in meant any todo movement rearmed the guard, so an
// agent working the list could keep `block` triggering turns indefinitely — and merely
// installing pi-todo would have changed whether pi-goal terminates at all. An optional
// enhancement must not be able to do that.
test("todo movement does NOT rearm the auto-continue guard", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    await set(api, { objective: "ship it" });
    for (let i = 0; i < 20; i++) {
      api.emitBus("todo:updated", {
        todos: [{ id: `${i}`, content: `task ${i}`, status: "done" }],
      });
      await api.fire("agent_settled", {}, fakeCtx());
    }
    expect(api.messages).toHaveLength(1);
  });
});

// THE termination guard, part two. The auto-continue message asks the agent to call
// `goal_set` — and carrying omitted fields forward is exactly what makes that restatement
// byte-identical. An unconditional `guard.reset()` in setState therefore let the nudge
// rearm the guard that permitted the next nudge, and `block` never terminated. The guard
// is now never reset on a write at all: `allow()` compares signatures, so an unchanged
// objective stays exhausted and a changed one rearms by itself.
test("restating the same objective does NOT refill the quota", async () => {
  await withConfig({ mode: "block", maxNudges: 2 }, async (api) => {
    await set(api, { objective: "ship it", criteria: "tests pass" });
    for (let i = 0; i < 30; i++) {
      await api.fire("agent_settled", {}, fakeCtx());
      // Exactly what the nudge text invites, and a perfect no-op after the fix.
      await set(api, { objective: "ship it" });
    }
    expect(api.messages).toHaveLength(2);
  });
});

test("a no-op restatement does not discard the widget's turn count either", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await set(api, { objective: "ship it" }, ctx);
    for (let i = 0; i < 6; i++) await api.fire("turn_end", {}, ctx);
    await set(api, { objective: "ship it" }, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines).toEqual(["▸ ship it", "  6 turns"]);
  });
});

test("compaction restoring the same objective does not refill the quota", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    const goal: Goal = { objective: "ship it", status: "active" };
    const ctx = fakeCtx({ branch: branchWith(goal) });
    await api.fire("session_start", {}, ctx);
    await api.fire("agent_settled", {}, fakeCtx());
    await api.fire("session_compact", {}, ctx);
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(1);
  });
});

test("a new objective rearms the guard — that is pi-goal's own state changing", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    await set(api, { objective: "first" });
    await api.fire("agent_settled", {}, fakeCtx());
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(1); // exhausted

    await set(api, { objective: "second" });
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(2);
  });
});

// A queued custom message becomes a permanent `user` message in the transcript, so an
// unbounded reminder-per-settle would stack duplicates of a line the standing injection
// already carries — for the rest of the session, in the default mode.
test("notify is bounded by the same guard, not once per settle forever", async () => {
  await withConfig({ mode: "notify", maxNudges: 2 }, async (api) => {
    await set(api, { objective: "ship it" });
    for (let i = 0; i < 30; i++) await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(2);
  });
});

test("meeting the objective resets the guard rather than leaving it exhausted", async () => {
  await withConfig({ mode: "notify", maxNudges: 1 }, async (api) => {
    await set(api, { objective: "first" });
    await api.fire("agent_settled", {}, fakeCtx());
    await api.fire("agent_settled", {}, fakeCtx());
    await set(api, { objective: "first", status: "met" });
    await api.fire("agent_settled", {}, fakeCtx()); // nothing to say; guard resets
    await set(api, { objective: "second" });
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Restore.
// ---------------------------------------------------------------------------

test("session_start restores the objective and repaints the widget", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const goal: Goal = { objective: "restored objective", status: "active" };
    const ctx = fakeCtx({ branch: branchWith(goal) });
    await api.fire("session_start", {}, ctx);
    expect(ctx.uiCalls.widgets).toEqual([{ id: "goal", lines: ["▸ restored objective"] }]);

    const result = (await api.fire("context", { messages: [] })) as {
      messages: Array<{ content: string }>;
    };
    expect(result.messages[0]!.content).toContain("restored objective");
  });
});

test("session_compact restores too — the injection must survive a context reset", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx({ branch: branchWith({ objective: "survives", status: "active" }) });
    await api.fire("session_compact", {}, ctx);
    const result = (await api.fire("context", { messages: [] })) as {
      messages: Array<{ content: string }>;
    };
    expect(result.messages[0]!.content).toContain("survives");
  });
});

test("a session with no goal entry clears the widget rather than leaving a stale one", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx({ branch: [] });
    await api.fire("session_start", {}, ctx);
    expect(ctx.uiCalls.widgets).toEqual([{ id: "goal", lines: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// The command's override.
// ---------------------------------------------------------------------------

test("/pi-goal clear empties the widget, the injection, and the session record", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await set(api, { objective: "ship it" });
    const ctx = fakeCtx();
    await api.commands.get("pi-goal")!.handler("clear", ctx);

    expect(await api.fire("context", { messages: [] })).toBeUndefined();
    expect(ctx.uiCalls.widgets).toEqual([{ id: "goal", lines: undefined }]);
    // Recorded, so a later restore does not resurrect what the user just cleared.
    expect(api.entries.at(-1)).toEqual({ customType: "goal-state", data: { goal: null } });
  });
});

// ---------------------------------------------------------------------------
// Peer independence — pi-todo is an enhancement, never a dependency.
// ---------------------------------------------------------------------------

test("todo progress folds into the widget when something publishes it", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await set(api, { objective: "ship it" }, ctx);
    api.emitBus("todo:updated", {
      todos: [
        { id: "1", content: "a", status: "done" },
        { id: "2", content: "b", status: "pending" },
      ],
    });
    // The bus callback gets only `data` — no ExtensionContext, so it cannot paint for
    // itself. The next turn_end is what surfaces it.
    await api.fire("turn_end", {}, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines!.join(" ")).toContain("1 of 2 todos done");
  });
});

test("with no publisher on the bus, everything works and the fragment never appears", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await set(api, { objective: "ship it" }, ctx);
    expect(api.emitted.map((e) => e.event)).toEqual(["goal:set"]);
    await api.fire("turn_end", {}, ctx);
    const widget = ctx.uiCalls.widgets.at(-1)!.lines!.join(" ");
    expect(widget).toContain("ship it");
    expect(widget).not.toContain("todos");

    const result = (await api.fire("context", { messages: [] })) as {
      messages: Array<{ content: string }>;
    };
    expect(result.messages[0]!.content).toContain("ship it");
  });
});

test("a malformed todo:updated payload does not break the subscriber", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await set(api, { objective: "ship it" }, ctx);
    expect(() => api.emitBus("todo:updated", { todos: "nonsense" })).not.toThrow();
    await api.fire("turn_end", {}, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines!.join(" ")).not.toContain("todos");
  });
});

// ---------------------------------------------------------------------------
// verify:passed — evidence about the objective, never a decision about it.
// ---------------------------------------------------------------------------

test("a passing verify shows in the widget and is named in the reminder", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("goal");
    const ctx = fakeCtx({});
    await api.tools.get("goal_set")!.execute(
      "1",
      { objective: "ship the auth refactor", criteria: "tokens rotate cleanly" } as never,
      undefined,
      undefined,
      ctx,
    );

    api.emitBus("verify:passed", { cmd: "bun test", cwd: process.cwd() });
    await api.fire("turn_end", {}, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines!.join(" ")).toContain("verify ✓");

    await api.fire("agent_settled", {}, ctx);
    const sent = api.messages.at(-1)!.message as { content: string };
    expect(sent.content).toContain("`bun test` passed");
    // Evidence, put as a question. Whether passing checks satisfy *this* objective is a
    // judgement about intent, and it stays the agent's to make via goal_set.
    expect(sent.content).toContain("does that satisfy the criteria?");
  });
});

test("the objective is never auto-marked met by a passing verify", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("goal");
    const ctx = fakeCtx({});
    await api.tools.get("goal_set")!.execute(
      "1",
      { objective: "ship the auth refactor" } as never,
      undefined,
      undefined,
      ctx,
    );
    api.emitBus("verify:passed", { cmd: "bun test", cwd: process.cwd() });
    await api.fire("agent_settled", {}, ctx);
    // Still open: the reminder fired at all, and nothing recorded a met goal.
    expect(api.messages.at(-1)).toBeDefined();
    const states = api.entries.filter((e) => e.customType === "goal-state");
    expect((states.at(-1)!.data as { goal: { status: string } }).goal.status).toBe("active");
  });
});

test("a passing verify does not carry over to a new objective", async () => {
  // A green run from before the goal changed must not vouch for work that has not
  // happened yet.
  await withConfig({}, async () => {
    const api = await loadExtension("goal");
    const ctx = fakeCtx({});
    const set = (objective: string) =>
      api.tools.get("goal_set")!.execute("1", { objective } as never, undefined, undefined, ctx);

    await set("first objective");
    api.emitBus("verify:passed", { cmd: "bun test", cwd: process.cwd() });
    await set("a different objective");
    await api.fire("turn_end", {}, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines!.join(" ")).not.toContain("verify ✓");
  });
});

test("a passing verify cannot rearm the nudge quota", async () => {
  // pi-goal's settle signature is its own state and nothing else. If a peer's signal
  // could refill the quota, installing pi-lens would silently change whether pi-goal's
  // `block` mode terminates — an optional enhancement must not do that.
  await withConfig({ mode: "block", maxNudges: 1 }, async () => {
    const api = await loadExtension("goal");
    const ctx = fakeCtx({});
    await api.tools.get("goal_set")!.execute(
      "1",
      { objective: "ship it" } as never,
      undefined,
      undefined,
      ctx,
    );
    await api.fire("agent_settled", {}, ctx);
    const afterFirst = api.messages.length;

    api.emitBus("verify:passed", { cmd: "bun test", cwd: process.cwd() });
    await api.fire("agent_settled", {}, ctx);
    expect(api.messages.length).toBe(afterFirst);
  });
});
