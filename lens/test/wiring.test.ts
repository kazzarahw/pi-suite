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
