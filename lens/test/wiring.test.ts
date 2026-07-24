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
