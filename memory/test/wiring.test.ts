import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, fakeCtx } from "../../shared/test/harness.ts";
import { saveConfig, DEFAULTS, type MemoryConfig } from "../src/config.ts";

function withConfig<T>(cfg: Partial<MemoryConfig>, fn: (agentDir: string) => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-wiring-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  saveConfig({ ...DEFAULTS, ...cfg });
  return fn(dir).finally(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  });
}

test("memory registers both tools and /pi-memory", async () => {
  const api = await loadExtension("memory");
  expect([...api.tools.keys()].sort()).toEqual(["memory_recall", "memory_write"]);
  expect([...api.commands.keys()]).toEqual(["pi-memory"]);
});

test("memory injects via the context hook and subscribes verify:failed on the bus", async () => {
  const api = await loadExtension("memory");
  expect(api.subscribes("context")).toBe(true);
  expect(api.busHandlers.has("verify:failed")).toBe(true);
});

test("context injection prepends the memory index once a memory exists", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("memory");
    const ctx = fakeCtx({ cwd: mkdtempSync(join(tmpdir(), "pi-memory-proj-")) });
    await api.tools.get("memory_write")!.execute(
      "1",
      { name: "a-fact", description: "a durable fact", content: "body", type: "project", scope: "global" } as never,
      undefined,
      undefined,
      ctx,
    );
    const original = [{ role: "user", content: "hi" }];
    const result = (await api.fire("context", { messages: original }, ctx)) as
      | { messages: Array<{ content: string }> }
      | undefined;

    expect(result).toBeDefined();
    expect(result!.messages.length).toBe(original.length + 1);
    expect(result!.messages[0]!.content).toContain("<pi-memory>");
    expect(result!.messages[0]!.content).toContain("a-fact");
  });
});

test("mode:off suppresses context injection", async () => {
  await withConfig({ mode: "off" }, async () => {
    const api = await loadExtension("memory");
    const ctx = fakeCtx();
    await api.tools.get("memory_write")!.execute(
      "1",
      { name: "b-fact", description: "d", content: "body", type: "project", scope: "global" } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(await api.fire("context", { messages: [] }, ctx)).toBeUndefined();
  });
});

test("verify:failed does NOT auto-capture while autoCapture is off (the default)", async () => {
  await withConfig({ autoCapture: false }, async () => {
    const api = await loadExtension("memory");
    api.emitBus("verify:failed", { cmd: "bun test", failures: ["a", "b"] });
    expect(api.emitted.filter((e) => e.event === "memory:wrote")).toEqual([]);
  });
});

/**
 * KNOWN DEFECT (scheduled for sub-project 2, "correctness hardening"):
 * the `verify:failed` auto-capture handler writes to `process.cwd()`, while both
 * memory tools correctly use `ctx.sessionManager.getCwd()`. A project-scope memory
 * therefore lands next to whatever directory pi was launched from rather than the
 * session's project — and, before this `chdir`, it polluted this repo when the
 * tests ran. The `chdir` below contains that; when the defect is fixed, replace it
 * with an assertion that the memory landed under the SESSION cwd.
 */
test("verify:failed auto-captures a gotcha when autoCapture is on", async () => {
  await withConfig({ autoCapture: true }, async () => {
    const api = await loadExtension("memory");
    const scratch = mkdtempSync(join(tmpdir(), "pi-memory-cwd-"));
    const origCwd = process.cwd();
    process.chdir(scratch);
    try {
      api.emitBus("verify:failed", { cmd: "bun test", failures: ["test a failed"] });
      const wrote = api.emitted.filter((e) => e.event === "memory:wrote");
      expect(wrote.length).toBe(1);
      expect(JSON.stringify(wrote[0]!.data)).toContain("gotcha-verify-");
      // Documents the defect: the memory landed under process.cwd(), not a session cwd.
      expect(existsSync(join(scratch, ".pi", "memory"))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });
});

test("verify:failed with no failures captures nothing", async () => {
  await withConfig({ autoCapture: true }, async () => {
    const api = await loadExtension("memory");
    api.emitBus("verify:failed", { cmd: "bun test", failures: [] });
    expect(api.emitted.filter((e) => e.event === "memory:wrote")).toEqual([]);
  });
});
