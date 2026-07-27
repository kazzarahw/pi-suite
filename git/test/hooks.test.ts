import { test, expect } from "bun:test";
import type { CheckpointStore, Heads, Manifest } from "../src/store.ts";
import {
  checkpointTurn,
  describeHeadDrift,
  describeRestore,
  guardWorkingSet,
  restoreEntry,
  restoreOnForkShutdown,
} from "../src/hooks.ts";

/** An in-memory CheckpointStore: the hooks' contract with storage, nothing else. */
function fakeStore(seeded: string[] = [], seededHeads: Heads = {}) {
  const manifests = new Map<string, Manifest>(seeded.map((id) => [id, { "/p/a.txt": { hash: "h" } }]));
  const heads = new Map<string, Heads>(seeded.map((id) => [id, seededHeads]));
  const restored: string[] = [];
  const store: CheckpointStore = {
    async checkpoint(entryId, paths, entryHeads) {
      const manifest: Manifest = Object.fromEntries(paths.map((p) => [p, { hash: `h:${p}` }]));
      manifests.set(entryId, manifest);
      heads.set(entryId, entryHeads ?? {});
      return manifest;
    },
    async rememberOrigin() {},
    async rememberOrigins() {},
    async restore(entryId) {
      restored.push(entryId);
      return {
        written: Object.keys(manifests.get(entryId) ?? {}),
        removed: [],
        heads: heads.get(entryId) ?? {},
      };
    },
    async has(entryId) {
      return manifests.has(entryId);
    },
    tracked: () => [],
    async gc() {
      return { sessions: 0, blobs: 0 };
    },
  };
  return { store, manifests, heads, restored };
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

  expect(summary).toEqual({ entryId: "u5", written: 1, removed: 0, heads: {} });
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
// The working-set guard, used before both kinds of change pi-git cannot follow.
//
// A subagent edits from its own `pi` process, so its writes never reach this extension's
// `tool_call` hook. `bash` reaches the hook but names no path, so there is nothing to
// record. Before this, a rewind past either left every file touched exactly as it was,
// while reporting success.
// ---------------------------------------------------------------------------

test("guardWorkingSet records an origin for every path it is given", async () => {
  const remembered: string[] = [];
  const store = {
    rememberOrigins: async (ps: readonly string[]) => void remembered.push(...ps),
  } as unknown as CheckpointStore;

  const summary = await guardWorkingSet(store, ["/a.ts", "/b.ts", "/c.ts"], 10);
  expect(remembered).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  expect(summary).toEqual({ recorded: 3, skipped: 0 });
});

test("guardWorkingSet reports what the cap left out rather than truncating silently", async () => {
  // A partial guard that looks total is the failure mode: the user would believe a
  // rewind covers files it cannot restore.
  const store = { rememberOrigins: async () => {} } as unknown as CheckpointStore;
  const summary = await guardWorkingSet(store, ["/a", "/b", "/c", "/d"], 2);
  expect(summary).toEqual({ recorded: 2, skipped: 2 });
});

test("a guard that throws does not take the turn with it", async () => {
  // The guard runs from `tool_call`. A hook that throws fails the tool call it was only
  // supposed to observe, so the whole batch is contained here as well as per-path inside
  // the store.
  const store = {
    rememberOrigins: async () => {
      throw new Error("EACCES");
    },
  } as unknown as CheckpointStore;

  const summary = await guardWorkingSet(store, ["/a", "/b"], 10);
  expect(summary).toEqual({ recorded: 2, skipped: 0 });
});

// ---------------------------------------------------------------------------
// Saying what happened.
// ---------------------------------------------------------------------------

test("describeRestore names what moved, and says nothing when nothing did", () => {
  expect(describeRestore({ entryId: "u1", written: 3, removed: 1, heads: {} })).toBe(
    "[pi-git] 3 file(s) restored, 1 removed.",
  );
  expect(describeRestore({ entryId: "u1", written: 2, removed: 0, heads: {} })).toBe(
    "[pi-git] 2 file(s) restored.",
  );
  // A restore that changed nothing has nothing to announce — the files were already there.
  expect(describeRestore({ entryId: "u1", written: 0, removed: 0, heads: {} })).toBeNull();
});

test("describeHeadDrift reports a HEAD that moved, and stays silent otherwise", () => {
  const drift = describeHeadDrift({ "/repo": "a".repeat(40) }, { "/repo": "b".repeat(40) });
  expect(drift).toContain("/repo is at bbbbbbbb, was aaaaaaaa");
  expect(drift).toContain("still in the log");

  // Unchanged, unrecorded, and unobserved all produce nothing: silence is never a claim
  // that no commit happened, only that this did not see one.
  expect(describeHeadDrift({ "/repo": "abc" }, { "/repo": "abc" })).toBeNull();
  expect(describeHeadDrift({}, { "/repo": "abc" })).toBeNull();
  expect(describeHeadDrift({ "/repo": "abc" }, {})).toBeNull();
});
