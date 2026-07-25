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
 * The auto-capture handler is a bus callback: `pi.events.on` delivers only `data`, with
 * no ExtensionContext, so it cannot resolve a cwd the way the tools do. It first fell
 * back to `process.cwd()`, writing project memories beside whatever directory Pi was
 * launched from — and polluting this repo when the tests ran, which is how it was found.
 * The fix after that kept a module-level latch of the last cwd seen from the `context`
 * hook, which worked but made this handler's correctness depend on an unrelated hook
 * having fired first.
 *
 * The cwd now travels in the payload, so the handler needs no prior state at all — and
 * works against any publisher of `verify:failed`, not just pi-lens.
 */
test("verify:failed auto-captures under the cwd in the payload", async () => {
  await withConfig({ autoCapture: true }, async () => {
    const api = await loadExtension("memory");
    const project = mkdtempSync(join(tmpdir(), "pi-memory-session-"));

    // No context hook fired first: the payload alone is sufficient.
    api.emitBus("verify:failed", { cmd: "bun test", failures: ["test a failed"], cwd: project });

    const wrote = api.emitted.filter((e) => e.event === "memory:wrote");
    expect(wrote.length).toBe(1);
    expect(JSON.stringify(wrote[0]!.data)).toContain("gotcha-verify-");
    expect(existsSync(join(project, ".pi", "memory"))).toBe(true);
    // The repo it was launched from must be untouched.
    expect(existsSync(join(process.cwd(), ".pi", "memory"))).toBe(false);
  });
});

// A payload with no cwd cannot be attributed to a project. Skipping is the only safe
// option — the original fallback guessed, and guessed wrong.
test("verify:failed with no cwd in the payload captures nothing", async () => {
  await withConfig({ autoCapture: true }, async () => {
    const api = await loadExtension("memory");
    api.emitBus("verify:failed", { cmd: "bun test", failures: ["test a failed"] });
    expect(api.emitted.filter((e) => e.event === "memory:wrote")).toEqual([]);
  });
});

// The cwd comes from the payload and nowhere else. A stale value observed from some
// earlier hook must not be able to redirect the write, which is what the latch allowed.
test("verify:failed ignores any cwd seen earlier from the context hook", async () => {
  await withConfig({ autoCapture: true }, async () => {
    const api = await loadExtension("memory");
    const seenEarlier = mkdtempSync(join(tmpdir(), "pi-memory-stale-"));
    const inPayload = mkdtempSync(join(tmpdir(), "pi-memory-payload-"));

    await api.fire("context", { messages: [] }, fakeCtx({ cwd: seenEarlier }));
    api.emitBus("verify:failed", { cmd: "bun test", failures: ["boom"], cwd: inPayload });

    expect(existsSync(join(inPayload, ".pi", "memory"))).toBe(true);
    expect(existsSync(join(seenEarlier, ".pi", "memory"))).toBe(false);
  });
});

test("verify:failed with no failures captures nothing", async () => {
  await withConfig({ autoCapture: true }, async () => {
    const api = await loadExtension("memory");
    api.emitBus("verify:failed", { cmd: "bun test", failures: [] });
    expect(api.emitted.filter((e) => e.event === "memory:wrote")).toEqual([]);
  });
});

/**
 * `/pi-memory delete <name>` — the suite's one destructive command verb.
 *
 * `deleteMemory` itself is covered thoroughly in store.test.ts; what was untested is the
 * wiring around it, which is where the interesting parts are: it resolves the cwd from
 * the invoking context rather than from anything captured at load, and it refuses a bare
 * `delete` instead of passing an empty name down to the store.
 */
test("/pi-memory delete removes the named memory from the invoking project", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("memory");
    const project = mkdtempSync(join(tmpdir(), "pi-memory-del-"));
    const ctx = fakeCtx({ cwd: project });
    await api.tools.get("memory_write")!.execute(
      "1",
      { name: "doomed", description: "d", content: "body", type: "project", scope: "project" } as never,
      undefined,
      undefined,
      ctx,
    );

    const notices: string[] = [];
    const cmdCtx = {
      mode: "print",
      ui: { notify: (m: string) => notices.push(m) },
      sessionManager: { getCwd: () => project },
    } as never;
    await api.commands.get("pi-memory")!.handler("delete doomed", cmdCtx);

    expect(notices.join("\n")).toContain('deleted "doomed"');
    const readout: string[] = [];
    await api.commands.get("pi-memory")!.handler("", {
      mode: "print",
      ui: { notify: (m: string) => readout.push(m) },
      sessionManager: { getCwd: () => project },
    } as never);
    expect(readout.join("\n")).not.toContain("doomed");
  });
});

test("/pi-memory delete with no name reports usage rather than deleting", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("memory");
    const project = mkdtempSync(join(tmpdir(), "pi-memory-del-bare-"));
    const ctx = fakeCtx({ cwd: project });
    await api.tools.get("memory_write")!.execute(
      "1",
      { name: "keeper", description: "d", content: "body", type: "project", scope: "project" } as never,
      undefined,
      undefined,
      ctx,
    );

    const notices: string[] = [];
    await api.commands.get("pi-memory")!.handler("delete", {
      mode: "print",
      ui: { notify: (m: string) => notices.push(m) },
      sessionManager: { getCwd: () => project },
    } as never);

    expect(notices.join("\n")).toContain("usage: delete <name>");
    // And the store is untouched — a bare `delete` must not sweep anything.
    const readout: string[] = [];
    await api.commands.get("pi-memory")!.handler("", {
      mode: "print",
      ui: { notify: (m: string) => readout.push(m) },
      sessionManager: { getCwd: () => project },
    } as never);
    expect(readout.join("\n")).toContain("keeper");
  });
});
