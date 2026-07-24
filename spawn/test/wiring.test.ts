import { test, expect } from "bun:test";
import { loadExtension, fakeCtx, createFakeApi } from "../../shared/test/harness.ts";

test("spawn registers the spawn tool and /pi-spawn", async () => {
  const api = await loadExtension("spawn");
  expect([...api.tools.keys()]).toEqual(["spawn"]);
  expect([...api.commands.keys()]).toEqual(["pi-spawn"]);
});

test("spawn registers no hooks — it is a pure tool extension", async () => {
  const api = await loadExtension("spawn");
  expect([...api.hooks.keys()]).toEqual([]);
});

/**
 * The fork-bomb guard. `PI_SPAWN_DEPTH` is read inside the extension factory, so
 * re-invoking the factory with a different env re-reads it — which is what lets this
 * be tested without a fresh module registry.
 */
async function loadAtDepth(depth: string) {
  const prev = process.env.PI_SPAWN_DEPTH;
  process.env.PI_SPAWN_DEPTH = depth;
  try {
    const api = createFakeApi();
    const mod = (await import("../index.ts")) as { default: (pi: unknown) => void };
    mod.default(api);
    return api;
  } finally {
    if (prev === undefined) delete process.env.PI_SPAWN_DEPTH;
    else process.env.PI_SPAWN_DEPTH = prev;
  }
}

test("spawn refuses to nest beyond depth 2 (fork-bomb guard)", async () => {
  const api = await loadAtDepth("2");
  await expect(
    api.tools.get("spawn")!.execute(
      "1",
      { tasks: [{ agent: "scout", task: "anything" }] } as never,
      undefined,
      undefined,
      fakeCtx(),
    ),
  ).rejects.toThrow(/max spawn depth/);
});

test("spawn permits nesting at depth 0 and 1", async () => {
  for (const depth of ["0", "1"]) {
    const api = await loadAtDepth(depth);
    // An unknown agent throws a DIFFERENT error than the depth guard — proving the
    // depth check passed rather than short-circuiting.
    await expect(
      api.tools.get("spawn")!.execute(
        "1",
        { tasks: [{ agent: "no-such-agent", task: "x" }] } as never,
        undefined,
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(/unknown agent/);
  }
});

test("spawn rejects an unknown agent and names the available roster", async () => {
  const api = await loadExtension("spawn");
  await expect(
    api.tools.get("spawn")!.execute(
      "1",
      { tasks: [{ agent: "definitely-not-real", task: "x" }] } as never,
      undefined,
      undefined,
      fakeCtx(),
    ),
  ).rejects.toThrow(/Available:/);
});
