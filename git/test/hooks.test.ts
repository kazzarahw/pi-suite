import { test, expect } from "bun:test";
import type { Git } from "../src/git.ts";
import { checkpointTurn, restoreOnForkShutdown } from "../src/hooks.ts";
import { checkpointRef } from "../src/checkpoints.ts";

function fakeGit(seed: Record<string, string> = {}) {
  const refs = new Map<string, string>(Object.entries(seed));
  const restored: string[] = [];
  let n = 0;
  const git: Git = {
    isRepo: async () => true,
    snapshotTree: async () => `sha${++n}`.padEnd(40, "0"),
    restoreTree: async (sha) => {
      restored.push(sha);
    },
    isDirty: async () => false,
    updateRef: async (ref, sha) => {
      refs.set(ref, sha);
    },
    readRef: async (ref) => refs.get(ref) ?? null,
    listRefs: async () => [],
    worktreeAdd: async () => "",
    worktreeList: async () => [],
    worktreeRemove: async () => {},
  };
  return { git, refs, restored };
}

function collectEmits() {
  const events: Array<{ event: string; data: unknown }> = [];
  return { emit: (event: string, data: unknown) => events.push({ event, data }), events };
}

test("checkpointTurn snapshots, stores the entry ref, and emits git:checkpoint", async () => {
  const { git, refs } = fakeGit();
  const { emit, events } = collectEmits();
  const cp = await checkpointTurn(git, "u1", "turn", "2026-07-23T00:00:00Z", emit);
  expect(refs.get(checkpointRef("u1"))).toBe(cp.sha);
  expect(events).toEqual([{ event: "git:checkpoint", data: { ref: checkpointRef("u1"), reason: "turn" } }]);
});

test("restoreOnForkShutdown restores a 'before' fork and emits git:rollback", async () => {
  const { git, restored } = fakeGit({ [checkpointRef("u5")]: "deadbeef".padEnd(40, "0") });
  const { emit, events } = collectEmits();
  const cp = await restoreOnForkShutdown(git, { entryId: "u5", position: "before" }, "fork", emit);
  expect(cp).not.toBeNull();
  expect(restored).toEqual(["deadbeef".padEnd(40, "0")]);
  expect(events).toEqual([{ event: "git:rollback", data: { ref: checkpointRef("u5"), reason: "rewind" } }]);
});

test("restoreOnForkShutdown does nothing for clone / non-fork / no-pending / missing-ref", async () => {
  const { git, restored } = fakeGit({ [checkpointRef("u5")]: "x".padEnd(40, "0") });
  const { emit, events } = collectEmits();

  expect(await restoreOnForkShutdown(git, { entryId: "u5", position: "at" }, "fork", emit)).toBeNull();
  expect(await restoreOnForkShutdown(git, { entryId: "u5", position: "before" }, "quit", emit)).toBeNull();
  expect(await restoreOnForkShutdown(git, null, "fork", emit)).toBeNull();
  expect(await restoreOnForkShutdown(git, { entryId: "missing", position: "before" }, "fork", emit)).toBeNull();

  expect(restored).toEqual([]);
  expect(events).toEqual([]);
});
