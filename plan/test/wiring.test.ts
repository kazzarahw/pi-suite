import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, fakeCtx, type FakeApi } from "../../shared/test/harness.ts";
import { saveConfig, DEFAULTS, type PlanConfig } from "../src/config.ts";
import { emptyPlan, type Plan } from "../src/state.ts";

/**
 * pi-plan's wiring: one tool, one command, and the hooks that keep the plan in front of
 * the agent and the agent inside the plan. Every test runs against a temp agent directory
 * so the real `~/.pi/agent/pi-plan.json` is never read or written.
 */
function withConfig<T>(cfg: Partial<PlanConfig>, fn: (api: FakeApi) => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-plan-wiring-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  saveConfig({ ...DEFAULTS, ...cfg });
  return loadExtension("plan")
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      rmSync(agentDir, { recursive: true, force: true });
    });
}

const call = (api: FakeApi, params: Record<string, unknown>, ctx = fakeCtx()) =>
  api.tools.get("plan")!.execute("c1", params as never, undefined, undefined, ctx);

/** Objective, two items, the first started — the ordinary mid-session state. */
async function working(api: FakeApi, ctx = fakeCtx()): Promise<void> {
  await call(api, { action: "objective", objective: "merge todo and goal" }, ctx);
  await call(api, { action: "items", items: [{ content: "design it" }, { content: "test it" }] }, ctx);
  await call(api, { action: "start", id: "1", approach: "read both first" }, ctx);
}

const branchWith = (plan: Plan) => [{ type: "custom", customType: "plan-state", data: { plan } }];
const edit = (api: FakeApi, ctx = fakeCtx()) =>
  api.fire("tool_call", { toolName: "write", input: { path: "/a.ts" } }, ctx);

/**
 * Settle nudges only.
 *
 * `session_start` / `session_compact` also queue a message — the resume block carrying the
 * log — so a bare `api.messages` count conflates the two whenever a test interleaves them.
 * The nudge is the one the user sees (`display: true`); the resume block is not.
 */
const nudges = (api: FakeApi) =>
  api.messages.filter((m) => (m.message as { display?: boolean }).display === true);

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

test("plan registers plan and /pi-plan", async () => {
  const api = await loadExtension("plan");
  expect([...api.tools.keys()]).toEqual(["plan"]);
  expect([...api.commands.keys()]).toEqual(["pi-plan"]);
});

test("plan subscribes the context, session, settle, and tool_call hooks", async () => {
  const api = await loadExtension("plan");
  for (const hook of ["context", "session_start", "session_compact", "agent_settled", "tool_call"]) {
    expect(api.subscribes(hook)).toBe(true);
  }
});

test("plan does NOT subscribe turn_end", async () => {
  // pi-goal aged its objective on turn_end purely to animate a turn counter. Every counter
  // pi-plan shows changes only on a tool call or a restore, and both already paint — so
  // the hook, the counter, and its "zero after a restore is the only honest value" caveat
  // all went away with the merge.
  const api = await loadExtension("plan");
  expect(api.subscribes("turn_end")).toBe(false);
});

// ---------------------------------------------------------------------------
// Standing context.
// ---------------------------------------------------------------------------

test("the objective and the active item ride along on every LLM call", async () => {
  await withConfig({}, async (api) => {
    await working(api);
    const result = (await api.fire("context", { messages: [{ role: "user", content: "hi" }] })) as {
      messages: Array<{ content: string }>;
    };
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.content).toContain("<pi-plan>");
    expect(result.messages[0]!.content).toContain("merge todo and goal");
    expect(result.messages[0]!.content).toContain("read both first");
    // Prepended, so the original turn still reads last.
    expect(result.messages[1]!.content).toBe("hi");
  });
});

test("nothing is injected before anything is planned", async () => {
  await withConfig({}, async (api) => {
    expect(await api.fire("context", { messages: [] })).toBeUndefined();
  });
});

test("the injection works without a UI", async () => {
  // The whole reason this is a `context` hook and not a queued message: returning messages
  // cannot stall `pi -p` waiting for a next prompt that never comes.
  await withConfig({}, async (api) => {
    await working(api, fakeCtx({ hasUI: false }));
    expect(await api.fire("context", { messages: [] }, fakeCtx({ hasUI: false }))).toBeDefined();
    expect(api.messages).toEqual([]);
  });
});

// THE prompt-cache guard, at the wiring level. The block lands at message index 0 of every
// call and the provider caches the conversation prefix, so it has to be stable for as long
// as the agent has not advanced. Counts, the open list, and the log go elsewhere.
test("the injected block is byte-identical across step ticks and log growth", async () => {
  await withConfig({}, async (api) => {
    await working(api);
    const inject = async () =>
      ((await api.fire("context", { messages: [] })) as { messages: Array<{ content: string }> })
        .messages[0]!.content;

    const first = await inject();
    await call(api, { action: "step", steps: ["one", "two"] });
    await call(api, { action: "step", index: 0, done: true });
    await call(api, { action: "drop", id: "2", reason: "unnecessary" });
    expect(await inject()).toBe(first);
    expect(first).not.toContain("open");
    expect(first).not.toContain("unnecessary");
  });
});

// ---------------------------------------------------------------------------
// mode: off — the no-op contract.
// ---------------------------------------------------------------------------

test("mode:off suppresses injection, nudge, and gate, but not the tool or the widget", async () => {
  await withConfig({ mode: "off" }, async (api) => {
    const ctx = fakeCtx();
    await working(api, ctx);
    // The widget still echoes a tool result — that is not automatic behaviour.
    expect(ctx.uiCalls.widgets.some((w) => w.id === "plan")).toBe(true);

    expect(await api.fire("context", { messages: [] })).toBeUndefined();
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toEqual([]);
    expect(await edit(api)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The gate — the Interdict half of `block`.
// ---------------------------------------------------------------------------

test("block refuses an edit when the plan is armed and nothing is active", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    await call(api, { action: "items", items: [{ content: "design it" }] });
    const result = (await edit(api)) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain('action "start"');
  });
});

test("block allows the edit once an item is active with an approach", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    await working(api);
    expect(await edit(api)).toBeUndefined();
  });
});

test("notify never refuses an edit, however unplanned", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    expect(await edit(api)).toBeUndefined();
  });
});

test("an empty plan is never gated, so installing pi-plan does not stop one-line sessions", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    expect(await edit(api)).toBeUndefined();
  });
});

// THE bound. `shared/mode.ts` is absolute that block never acts without one: an agent that
// cannot work out what the gate wants would otherwise be unable to edit anything for the
// rest of the session, with no way out but the settings panel.
test("the gate gives up after maxBlocks and lets the edit through with a notice", async () => {
  await withConfig({ mode: "block", maxBlocks: 2 }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    const ctx = fakeCtx();

    expect(((await edit(api, ctx)) as { block: boolean }).block).toBe(true);
    expect(((await edit(api, ctx)) as { block: boolean }).block).toBe(true);
    // Third time against unchanged state: the refusals have achieved nothing.
    expect(await edit(api, ctx)).toBeUndefined();
    expect(ctx.uiCalls.notices.map((n) => n.msg).join("\n")).toContain("letting this edit through");
  });
});

test("real progress rearms the gate rather than leaving it permanently spent", async () => {
  await withConfig({ mode: "block", maxBlocks: 1 }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    expect(((await edit(api)) as { block: boolean }).block).toBe(true);
    expect(await edit(api)).toBeUndefined(); // spent

    // The plan moved, so the next refusal is about a genuinely different situation.
    await call(api, { action: "items", items: [{ content: "design it" }] });
    expect(((await edit(api)) as { block: boolean }).block).toBe(true);
  });
});

test("a gate that throws lets the edit through rather than failing the turn", async () => {
  // "A hook must never break the turn it observes." A gate that crashes the edit it meant
  // to question is worse than no gate — the edit proceeds and the failure is reported.
  await withConfig({ mode: "block" }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    const ctx = fakeCtx();
    // `toolName` is the first thing the handler touches, so this throws inside the try.
    const exploding = {
      get toolName(): never {
        throw new Error("boom");
      },
    };
    expect(await api.fire("tool_call", exploding, ctx)).toBeUndefined();
    expect(ctx.uiCalls.notices.map((n) => n.msg).join()).toContain("gate error: boom");
  });
});

test("the plan tool itself is never gated", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    expect(await api.fire("tool_call", { toolName: "plan", input: {} }, fakeCtx())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The settle nudge — the Insist half.
// ---------------------------------------------------------------------------

test("notify reminds on settle while work is outstanding", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await working(api);
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(1);
    expect((api.messages[0]!.options as { deliverAs: string }).deliverAs).toBe("nextTurn");
  });
});

test("block auto-continues the turn instead", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    await working(api);
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    expect((api.messages[0]!.options as { triggerTurn: boolean }).triggerTurn).toBe(true);
  });
});

// THE print-mode hang guard. Injecting a message when there is no interactive UI makes Pi
// wait forever for a "next prompt" that never arrives.
test("no settle nudge and no session injection without a UI", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    await working(api, fakeCtx({ hasUI: false }));
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx({ hasUI: false }));
    expect(api.messages).toEqual([]);

    await api.fire("session_start", {}, fakeCtx({ hasUI: false, branch: branchWith(emptyPlan()) }));
    expect(api.messages).toEqual([]);
  });
});

test("nothing to say once everything is resolved and the objective is met", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    await working(api);
    await call(api, { action: "finish", note: "done" });
    await call(api, { action: "drop", id: "2", reason: "unnecessary" });
    await call(api, { action: "objective", objective: "merge todo and goal", status: "met" });
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toEqual([]);
  });
});

// THE termination guard, and the regression the merge would otherwise reintroduce.
//
// pi-goal shipped a fixed bug: folding a peer's progress into the objective's settle
// signature meant any task movement rearmed the guard, so `block` never terminated. With
// the list and the objective now in ONE object, `JSON.stringify(plan)` is the obvious
// signature and it is exactly that bug — one signature over one tree, moving whenever any
// leaf moves.
test("item movement does NOT rearm the objective quota", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    api.messages.length = 0;

    // An objective with nothing under it nudges on the objective quota. Churning items in
    // and out must not refill it.
    for (let i = 0; i < 20; i++) {
      await api.fire("agent_settled", {}, fakeCtx());
      await call(api, { action: "items", items: [{ content: `churn ${i}` }] });
      await call(api, { action: "items", items: [] });
    }
    expect(api.messages).toHaveLength(1);
  });
});

test("restating the same objective does NOT refill the quota", async () => {
  // The nudge literally asks the agent to call `plan`, and carrying omitted fields forward
  // is what makes that restatement byte-identical. An unconditional guard reset on write
  // would let the nudge rearm the guard that permitted the next nudge.
  await withConfig({ mode: "block", maxNudges: 2 }, async (api) => {
    await call(api, { action: "objective", objective: "ship it", criteria: "tests pass" });
    api.messages.length = 0;
    for (let i = 0; i < 30; i++) {
      await api.fire("agent_settled", {}, fakeCtx());
      await call(api, { action: "objective", objective: "ship it" });
    }
    expect(api.messages).toHaveLength(2);
  });
});

test("a new objective rearms the quota — that is pi-plan's own state changing", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    await call(api, { action: "objective", objective: "first" });
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(1); // exhausted

    await call(api, { action: "objective", objective: "second" });
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(2);
  });
});

test("the item guard is a no-progress detector, and real item progress rearms it", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    await call(api, { action: "items", items: [{ content: "a" }, { content: "b" }] });
    api.messages.length = 0;

    // Unchanged items: the first nudge plus one retry, then silence.
    for (let i = 0; i < 6; i++) await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(2);

    // The work product moved, so the guard rearms — which is exactly what a no-progress
    // detector is for, and why the item half is not a quota.
    await call(api, { action: "items", items: [{ content: "a" }] });
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(3);
  });
});

test("the quotas are read from config per settle, not captured at load", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    await call(api, { action: "objective", objective: "ship it" });
    api.messages.length = 0;
    for (let i = 0; i < 3; i++) await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Restore.
// ---------------------------------------------------------------------------

test("session_start restores the plan, repaints, and re-injects it", async () => {
  await withConfig({}, async (api) => {
    const stored: Plan = {
      objective: { objective: "restored objective", status: "active" },
      items: [{ id: "1", content: "still open", status: "pending" }],
      log: [{ content: "abandoned", outcome: "dropped", note: "the API already does this" }],
      seq: 2,
    };
    const ctx = fakeCtx({ branch: branchWith(stored) });
    await api.fire("session_start", {}, ctx);

    expect(ctx.uiCalls.widgets.at(-1)!.lines).toContain("▸ restored objective");
    const injected = (await api.fire("context", { messages: [] })) as {
      messages: Array<{ content: string }>;
    };
    expect(injected.messages[0]!.content).toContain("restored objective");
  });
});

// THE reason the log exists. A finish/drop echo lives in the transcript and dies at
// compaction — which is exactly when the agent forgets it already abandoned something and
// proposes it again. The standing block deliberately does not carry the log, so this
// message is the only thing that does.
test("compaction replays the log, so a dropped item's reason is not lost with the transcript", async () => {
  await withConfig({}, async (api) => {
    const stored: Plan = {
      objective: { objective: "merge todo and goal", status: "active" },
      items: [],
      log: [{ content: "write a migration", outcome: "dropped", note: "the API already does this" }],
      seq: 2,
    };
    await api.fire("session_compact", {}, fakeCtx({ branch: branchWith(stored) }));
    const sent = JSON.stringify(api.messages);
    expect(sent).toContain("write a migration");
    expect(sent).toContain("the API already does this");
    expect(sent).toContain("do not re-propose");
  });
});

test("a session with no plan entry clears the widget rather than leaving a stale one", async () => {
  await withConfig({}, async (api) => {
    const ctx = fakeCtx({ branch: [] });
    await api.fire("session_start", {}, ctx);
    expect(ctx.uiCalls.widgets).toEqual([{ id: "plan", lines: undefined }]);
    expect(api.messages).toEqual([]);
  });
});

test("compaction restoring the same plan does not refill a quota", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    const stored: Plan = { ...emptyPlan(), objective: { objective: "ship it", status: "active" } };
    const ctx = fakeCtx({ branch: branchWith(stored) });
    await api.fire("session_start", {}, ctx);
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    await api.fire("session_compact", {}, ctx);
    await api.fire("agent_settled", {}, fakeCtx());
    // Counting nudges specifically: the compaction also queues a resume block, and
    // conflating the two would hide whether the quota actually held.
    expect(nudges(api)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The command's overrides, and the peer.
// ---------------------------------------------------------------------------

test("/pi-plan clear empties the widget and the injection but records the surviving log", async () => {
  await withConfig({}, async (api) => {
    await working(api);
    await call(api, { action: "drop", id: "2", reason: "unnecessary" });
    const ctx = fakeCtx();
    await api.commands.get("pi-plan")!.handler("clear", ctx);

    expect(await api.fire("context", { messages: [] })).toBeUndefined();
    expect(ctx.uiCalls.widgets.at(-1)!.lines).toEqual(["  1 dropped"]);
    // Recorded, so a later restore does not resurrect what the user just cleared — and the
    // log rides along, so the agent still knows what was abandoned.
    const recorded = api.entries.at(-1)!.data as { plan: Plan };
    expect(recorded.plan.objective).toBeNull();
    expect(recorded.plan.log).toHaveLength(1);
  });
});

test("/pi-plan clear disarms the gate, which is the escape hatch from block mode", async () => {
  await withConfig({ mode: "block" }, async (api) => {
    await call(api, { action: "objective", objective: "merge todo and goal" });
    expect(((await edit(api)) as { block: boolean }).block).toBe(true);
    await api.commands.get("pi-plan")!.handler("clear", fakeCtx());
    expect(await edit(api)).toBeUndefined();
  });
});

test("/pi-plan reset records an empty plan, log and all", async () => {
  await withConfig({}, async (api) => {
    await working(api);
    await call(api, { action: "drop", id: "2", reason: "unnecessary" });
    await api.commands.get("pi-plan")!.handler("reset", fakeCtx());
    expect((api.entries.at(-1)!.data as { plan: Plan }).plan).toEqual(emptyPlan());
  });
});

test("a passing verify shows in the widget and is named in the objective reminder", async () => {
  await withConfig({ mode: "notify" }, async (api) => {
    const ctx = fakeCtx();
    await call(api, { action: "objective", objective: "ship it", criteria: "tests pass" }, ctx);
    api.emitBus("verify:passed", { cmd: "bun test", cwd: "/anywhere" });
    // The bus callback gets only `data` — no ExtensionContext, so it cannot paint for
    // itself. The next tool call is what surfaces it.
    await call(api, { action: "objective", objective: "ship it" }, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines!.join(" ")).toContain("verify ✓");

    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    expect(JSON.stringify(api.messages)).toContain("does that satisfy the criteria?");
  });
});

test("with no publisher on the bus everything works and the fragment never appears", async () => {
  await withConfig({}, async (api) => {
    const ctx = fakeCtx();
    await call(api, { action: "objective", objective: "ship it" }, ctx);
    expect(ctx.uiCalls.widgets.at(-1)!.lines!.join(" ")).not.toContain("verify");
  });
});

test("a malformed verify:passed payload does not break the subscriber", async () => {
  await withConfig({}, async (api) => {
    await call(api, { action: "objective", objective: "ship it" });
    expect(() => api.emitBus("verify:passed", { cmd: 42 })).not.toThrow();
  });
});

// A peer's signal may not reach either nudge guard. If it could rearm a quota, installing
// pi-lens would silently change whether pi-plan's `block` mode terminates.
test("a passing verify cannot rearm the nudge quota", async () => {
  await withConfig({ mode: "block", maxNudges: 1 }, async (api) => {
    await call(api, { action: "objective", objective: "ship it" });
    api.messages.length = 0;
    await api.fire("agent_settled", {}, fakeCtx());
    const afterFirst = api.messages.length;

    api.emitBus("verify:passed", { cmd: "bun test", cwd: "/anywhere" });
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.messages.length).toBe(afterFirst);
  });
});
