import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, fakeCtx } from "../../shared/test/harness.ts";
import { saveConfig, DEFAULTS, type LensConfig } from "../src/config.ts";

/** Point pi-lens's config at a temp agent dir so tests can set mode without touching real config. */
function withConfig<T>(cfg: Partial<LensConfig>, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-lens-wiring-"));
  saveConfig({ ...DEFAULTS, ...cfg });
  return fn().finally(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  });
}

test("lens registers the lens tool and /pi-lens", async () => {
  const api = await loadExtension("lens");
  expect([...api.tools.keys()]).toEqual(["lens"]);
  expect([...api.commands.keys()]).toEqual(["pi-lens"]);
});

test("lens subscribes tool_result, agent_settled, session_start, session_shutdown", async () => {
  const api = await loadExtension("lens");
  for (const hook of ["tool_result", "agent_settled", "session_start", "session_shutdown"]) {
    expect(api.subscribes(hook)).toBe(true);
  }
});

test("lens ignores tool_result for tools that are not read/write/edit", async () => {
  const api = await loadExtension("lens");
  const result = await api.fire(
    "tool_result",
    { toolName: "bash", input: { command: "ls" }, content: [], details: {}, isError: false },
    fakeCtx(),
  );
  expect(result).toBeUndefined();
});

test("lens ignores a file tool call with no resolvable path", async () => {
  const api = await loadExtension("lens");
  const result = await api.fire(
    "tool_result",
    { toolName: "read", input: {}, content: [], details: {}, isError: false },
    fakeCtx(),
  );
  expect(result).toBeUndefined();
});

test("mode:off suppresses diagnostics injection entirely", async () => {
  await withConfig({ mode: "off" }, async () => {
    const api = await loadExtension("lens");
    const dir = mkdtempSync(join(tmpdir(), "pi-lens-off-"));
    const file = join(dir, "x.ts");
    writeFileSync(file, "const x: number = 'nope';\n");
    const result = await api.fire(
      "tool_result",
      { toolName: "read", input: { path: file }, content: [], details: {}, isError: false },
      fakeCtx({ cwd: dir }),
    );
    expect(result).toBeUndefined();
  });
});

test("mode:off suppresses the verify pass on settle", async () => {
  await withConfig({ mode: "off" }, async () => {
    const api = await loadExtension("lens");
    await api.fire("agent_settled", {}, fakeCtx());
    expect(api.emitted.filter((e) => e.event.startsWith("verify:"))).toEqual([]);
  });
});

// The print-mode guard (see todo/test/wiring.test.ts): lens must not queue a verify
// message when there is no interactive UI.
test("lens sends no verify message when there is no UI", async () => {
  const api = await loadExtension("lens");
  await api.fire("agent_settled", {}, fakeCtx({ hasUI: false }));
  expect(api.messages).toEqual([]);
});

test("prewarm does not run without a UI", async () => {
  const api = await loadExtension("lens");
  await api.fire("session_start", {}, fakeCtx({ hasUI: false }));
  // No assertion on servers (that would spawn real ones); the guard is that this
  // returns without throwing and queues nothing.
  expect(api.messages).toEqual([]);
});

test("the lens tool rejects an unsupported file type rather than hanging", async () => {
  const api = await loadExtension("lens");
  const dir = mkdtempSync(join(tmpdir(), "pi-lens-unsup-"));
  const file = join(dir, "notes.unknownext");
  writeFileSync(file, "hello\n");
  await expect(
    api.tools.get("lens")!.execute("1", { action: "hover", path: file, line: 1, col: 1 } as never, undefined, undefined, fakeCtx()),
  ).rejects.toThrow(/no language server/);
});

// --- Session cwd and project trust -----------------------------------------

test("lens resolves the session cwd, not process.cwd(), for diagnostics", async () => {
  // The old code read process.cwd() once in the extension factory. A tool_result for a
  // relative path must resolve against the session's directory instead.
  const dir = mkdtempSync(join(tmpdir(), "pi-lens-cwd-"));
  writeFileSync(join(dir, "a.ts"), "const x: number = 1;\n");
  await withConfig({ mode: "notify" }, async () => {
    const api = await loadExtension("lens");
    const result = (await api.fire(
      "tool_result",
      { toolName: "read", input: { path: "a.ts" }, content: [], details: {}, isError: false },
      fakeCtx({ cwd: dir }),
    )) as { content?: unknown[] } | undefined;
    // Either it injected a block or it emitted lens:clean — both prove it resolved the
    // file under `dir`. What it must not do is act on the repo's own directory.
    const events = api.emitted.filter((e) => e.event.startsWith("lens:"));
    expect(events.length).toBeGreaterThan(0);
    const file = (events[0]!.data as { file: string }).file;
    expect(file.startsWith(dir)).toBe(true);
    void result;
  });
});

// The trust gate, end to end through the hook. An untrusted project must not run a
// command that the repository itself supplied.
test("agent_settled runs no autodetected verify in an untrusted project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lens-untrusted-"));
  writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
  // bun.lock makes autodetectVerify return "bun test" — a command from the repo.
  writeFileSync(join(dir, "bun.lock"), "");
  await withConfig({ mode: "notify", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const ctx = fakeCtx({ cwd: dir, isProjectTrusted: false });
    // Mark the session dirty so verify would otherwise be eligible.
    await api.fire(
      "tool_result",
      { toolName: "write", input: { path: "a.ts" }, content: [], details: {}, isError: false },
      ctx,
    );
    await api.fire("agent_settled", {}, ctx);
    expect(api.emitted.filter((e) => e.event.startsWith("verify:"))).toEqual([]);
    // And it says so, rather than failing silently.
    expect(ctx.uiCalls.notices.some((n) => /not trusted/i.test(n.msg))).toBe(true);
  });
}, 20_000);

test("the untrusted notice is shown once per session, not once per settle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lens-untrusted2-"));
  writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
  writeFileSync(join(dir, "bun.lock"), "");
  await withConfig({ mode: "notify", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const ctx = fakeCtx({ cwd: dir, isProjectTrusted: false });
    await api.fire(
      "tool_result",
      { toolName: "write", input: { path: "a.ts" }, content: [], details: {}, isError: false },
      ctx,
    );
    await api.fire("agent_settled", {}, ctx);
    await api.fire("agent_settled", {}, ctx);
    expect(ctx.uiCalls.notices.filter((n) => /not trusted/i.test(n.msg))).toHaveLength(1);
  });
}, 20_000);

// --- Verify delivery -------------------------------------------------------
//
// `deliverAs` only ever reaches the *agent*, and a queued message is not drawn until it
// is delivered. On the turn that broke the build the user therefore saw the agent say
// "done" and nothing else, and the agent met the failure one turn later, adjacent to the
// user's next message — where it read the harness block as something the user had pasted
// and asked permission instead of acting.

/** A project whose autodetected verify command fails. */
function failingProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-lens-verify-"));
  writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "t", scripts: { test: 'echo "(fail) broken_test"; exit 1' } }),
  );
  return dir;
}

/** A project whose autodetected verify command passes. */
function passingProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-lens-verify-ok-"));
  writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { test: "exit 0" } }));
  return dir;
}

const dirty = (api: Awaited<ReturnType<typeof loadExtension>>, ctx: ReturnType<typeof fakeCtx>) =>
  api.fire(
    "tool_result",
    { toolName: "write", input: { path: "a.ts" }, content: [], details: {}, isError: false },
    ctx,
  );

test("a failed verify reaches the user at settle, not on their next message", async () => {
  const dir = failingProject();
  await withConfig({ mode: "notify", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const ctx = fakeCtx({ cwd: dir });
    await dirty(api, ctx);
    await api.fire("agent_settled", {}, ctx);

    const notice = ctx.uiCalls.notices.find((n) => /FAILED/.test(n.msg));
    expect(notice).toBeDefined();
    expect(notice!.level).toBe("warning");
  });
}, 30_000);

test("notify mode never compels a turn", async () => {
  const dir = failingProject();
  await withConfig({ mode: "notify", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const ctx = fakeCtx({ cwd: dir });
    await dirty(api, ctx);
    await api.fire("agent_settled", {}, ctx);

    const sent = api.messages.at(-1);
    expect(sent).toBeDefined();
    expect((sent!.options as { deliverAs?: string }).deliverAs).toBe("nextTurn");
    expect((sent!.options as { triggerTurn?: boolean }).triggerTurn).toBeUndefined();
    // The user already has it from the notification; rendering it twice teaches them to
    // ignore both.
    expect((sent!.message as { display?: boolean }).display).toBe(false);
  });
}, 30_000);

test("block mode insists: the failure is delivered as a follow-up that triggers a turn", async () => {
  const dir = failingProject();
  await withConfig({ mode: "block", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const ctx = fakeCtx({ cwd: dir });
    await dirty(api, ctx);
    await api.fire("agent_settled", {}, ctx);

    const sent = api.messages.at(-1);
    expect(sent).toBeDefined();
    expect(sent!.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
  });
}, 30_000);

test("block mode stops insisting once the same failures stop changing", async () => {
  // The agent that broke the build may never fix it. Without the guard, "keep going until
  // green" has no exit condition of its own.
  const dir = failingProject();
  await withConfig({ mode: "block", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const ctx = fakeCtx({ cwd: dir });
    for (let i = 0; i < 4; i++) {
      await dirty(api, ctx); // a fresh edit each round, so the gate re-arms
      await api.fire("agent_settled", {}, ctx);
    }
    const triggered = api.messages.filter(
      (m) => (m.options as { triggerTurn?: boolean }).triggerTurn === true,
    );
    expect(triggered.length).toBeLessThanOrEqual(2);
  });
}, 40_000);

test("a passing verify tells the user and says nothing to the agent", async () => {
  // Spending a turn's attention to report that nothing happened is how a useful signal
  // becomes noise.
  const dir = passingProject();
  await withConfig({ mode: "notify", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const ctx = fakeCtx({ cwd: dir });
    await dirty(api, ctx);
    await api.fire("agent_settled", {}, ctx);

    expect(ctx.uiCalls.notices.some((n) => /passed/.test(n.msg))).toBe(true);
    expect(api.messages).toEqual([]);
  });
}, 30_000);

// --- Standing context ------------------------------------------------------

test("lens declares itself on every call so the agent stops checking by hand", async () => {
  const dir = passingProject();
  await withConfig({ mode: "notify", verifyCmd: "" }, async () => {
    const api = await loadExtension("lens");
    const result = (await api.fire("context", { messages: [{ role: "user", content: "hi" }] }, fakeCtx({ cwd: dir }))) as
      | { messages: Array<{ content: string }> }
      | undefined;
    expect(result?.messages[0]!.content).toContain("<pi-lens>");
    expect(result?.messages[0]!.content).toContain("clean");
    // Prepended, never replacing what was there.
    expect(result?.messages).toHaveLength(2);
  });
});

test("mode off injects no standing context", async () => {
  await withConfig({ mode: "off" }, async () => {
    const api = await loadExtension("lens");
    const result = await api.fire("context", { messages: [{ role: "user", content: "hi" }] }, fakeCtx());
    expect(result).toBeUndefined();
  });
});
