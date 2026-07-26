import { test, expect } from "bun:test";
import type { CheckpointStore, Manifest } from "../src/store.ts";
import { checkpointTurn, restoreEntry, restoreOnForkShutdown, guardDelegation } from "../src/hooks.ts";

/** An in-memory CheckpointStore: the hooks' contract with storage, nothing else. */
function fakeStore(seeded: string[] = []) {
  const manifests = new Map<string, Manifest>(seeded.map((id) => [id, { "/p/a.txt": { hash: "h" } }]));
  const restored: string[] = [];
  const store: CheckpointStore = {
    async checkpoint(entryId, paths) {
      const manifest: Manifest = Object.fromEntries(paths.map((p) => [p, { hash: `h:${p}` }]));
      manifests.set(entryId, manifest);
      return manifest;
    },
    async rememberOrigin() {},
    async restore(entryId) {
      restored.push(entryId);
      return { written: Object.keys(manifests.get(entryId) ?? {}), removed: [] };
    },
    async has(entryId) {
      return manifests.has(entryId);
    },
    tracked: () => [],
    async gc() {
      return { sessions: 0, blobs: 0 };
    },
  };
  return { store, manifests, restored };
}

function collectEmits() {
  const events: Array<{ event: string; data: unknown }> = [];
  return { emit: (event: string, data: unknown) => events.push({ event, data }), events };
}

test("checkpointTurn records the paths under the entry and emits git:checkpoint", async () => {
  const { store, manifests } = fakeStore();
  const { emit, events } = collectEmits();

  const summary = await checkpointTurn(store, "u1", ["/p/a.txt", "/p/b.txt"], "turn", emit);

  expect(summary).toEqual({ entryId: "u1", files: 2 });
  expect(Object.keys(manifests.get("u1")!).sort()).toEqual(["/p/a.txt", "/p/b.txt"]);
  expect(events).toEqual([{ event: "git:checkpoint", data: { entryId: "u1", files: 2, reason: "turn" } }]);
});

test("restoreEntry restores and emits git:rollback", async () => {
  const { store, restored } = fakeStore(["u5"]);
  const { emit, events } = collectEmits();

  const summary = await restoreEntry(store, "u5", "tree", emit);

  expect(summary).toEqual({ entryId: "u5", written: 1, removed: 0 });
  expect(restored).toEqual(["u5"]);
  expect(events).toEqual([
    { event: "git:rollback", data: { entryId: "u5", written: 1, removed: 0, reason: "tree" } },
  ]);
});

// A restore that has no checkpoint to work from must say so by returning null, not by
// returning a zero-file success. The caller turns that into a visible notice; treating
// the two the same is how "nothing happened" gets mistaken for "nothing to undo".
test("restoreEntry does nothing, and emits nothing, for an unknown or null entry", async () => {
  const { store, restored } = fakeStore(["u5"]);
  const { emit, events } = collectEmits();

  expect(await restoreEntry(store, "missing", "tree", emit)).toBeNull();
  expect(await restoreEntry(store, null, "tree", emit)).toBeNull();
  expect(restored).toEqual([]);
  expect(events).toEqual([]);
});

test("restoreOnForkShutdown restores a 'before' fork and emits git:rollback", async () => {
  const { store, restored } = fakeStore(["u5"]);
  const { emit, events } = collectEmits();

  const summary = await restoreOnForkShutdown(store, { entryId: "u5", position: "before" }, "fork", emit);

  expect(summary).not.toBeNull();
  expect(restored).toEqual(["u5"]);
  expect(events).toEqual([
    { event: "git:rollback", data: { entryId: "u5", written: 1, removed: 0, reason: "rewind" } },
  ]);
});

test("restoreOnForkShutdown does nothing for clone / non-fork / no-pending / missing entry", async () => {
  const { store, restored } = fakeStore(["u5"]);
  const { emit, events } = collectEmits();

  expect(await restoreOnForkShutdown(store, { entryId: "u5", position: "at" }, "fork", emit)).toBeNull();
  expect(await restoreOnForkShutdown(store, { entryId: "u5", position: "before" }, "quit", emit)).toBeNull();
  expect(await restoreOnForkShutdown(store, null, "fork", emit)).toBeNull();
  expect(await restoreOnForkShutdown(store, { entryId: "gone", position: "before" }, "fork", emit)).toBeNull();

  expect(restored).toEqual([]);
  expect(events).toEqual([]);
});

// ---------------------------------------------------------------------------
// The delegation guard.
//
// A subagent edits from its own `pi` process, so its writes never reach this
// extension's `tool_call` hook — the hook that captures a file's pre-edit bytes. Before
// this, a rewind past a delegation left every file the subagent touched exactly as it
// left them, while reporting success.
// ---------------------------------------------------------------------------

test("guardDelegation records an origin for every path it is given", async () => {
  const remembered: string[] = [];
  const store = { rememberOrigin: async (p: string) => void remembered.push(p) } as unknown as CheckpointStore;

  const summary = await guardDelegation(store, ["/a.ts", "/b.ts", "/c.ts"], 10);
  expect(remembered).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  expect(summary).toEqual({ recorded: 3, skipped: 0 });
});

test("guardDelegation reports what the cap left out rather than truncating silently", async () => {
  // A partial guard that looks total is the failure mode: the user would believe a
  // rewind covers files it cannot restore.
  const store = { rememberOrigin: async () => {} } as unknown as CheckpointStore;
  const summary = await guardDelegation(store, ["/a", "/b", "/c", "/d"], 2);
  expect(summary).toEqual({ recorded: 2, skipped: 2 });
});

test("one unreadable file does not abandon the rest of the working set", async () => {
  const remembered: string[] = [];
  const store = {
    rememberOrigin: async (p: string) => {
      if (p === "/bad") throw new Error("EACCES");
      remembered.push(p);
    },
  } as unknown as CheckpointStore;

  const summary = await guardDelegation(store, ["/a", "/bad", "/c"], 10);
  expect(remembered).toEqual(["/a", "/c"]);
  expect(summary.recorded).toBe(3);
});
