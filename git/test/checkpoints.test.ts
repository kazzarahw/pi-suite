import { test, expect } from "bun:test";
import {
  currentLeafId,
  currentUserEntryId,
  resolveRestoreTarget,
  type SessionManagerLike,
} from "../src/checkpoints.ts";

test("currentUserEntryId returns the leaf when it is a user message", () => {
  const sm = {
    getLeafEntry: () => ({ type: "message", id: "u2", message: { role: "user" } }),
    getBranch: () => [],
  };
  expect(currentUserEntryId(sm)).toBe("u2");
});

test("currentUserEntryId falls back to the last user message in the branch", () => {
  const sm = {
    getLeafEntry: () => ({ type: "message", id: "a9", message: { role: "assistant" } }),
    getBranch: () => [
      { type: "message", id: "u1", message: { role: "user" } },
      { type: "message", id: "a1", message: { role: "assistant" } },
      { type: "custom", id: "c1" },
    ],
  };
  expect(currentUserEntryId(sm)).toBe("u1");
});

test("currentUserEntryId is null when there is no user message", () => {
  expect(currentUserEntryId({ getLeafEntry: () => undefined, getBranch: () => [] })).toBeNull();
});

test("currentLeafId prefers getLeafId and falls back to the leaf entry's id", () => {
  expect(currentLeafId({ getLeafId: () => "leaf-7" })).toBe("leaf-7");
  expect(currentLeafId({ getLeafEntry: () => ({ type: "message", id: "a3" }) })).toBe("a3");
  expect(currentLeafId({})).toBeNull();
});

// --- resolveRestoreTarget --------------------------------------------------
//
// Navigation reports a *leaf* id, and only some entries carry a checkpoint: a user
// message (checkpointed at message_start) and whatever leaf the session left from
// (checkpointed at session_before_tree). Walking up the ancestor chain finds
// whichever applies, so forward and backward navigation each restore the right
// state without either overwriting the other's record.

function tree(entries: Record<string, string | null>): SessionManagerLike {
  return { getEntry: (id) => (id in entries ? { id, parentId: entries[id]! } : undefined) };
}

const hasAny = (ids: string[]) => async (id: string) => ids.includes(id);

test("resolveRestoreTarget returns the destination itself when it has a checkpoint", async () => {
  const sm = tree({ a2: "u2", u2: "a1", a1: "u1", u1: null });
  expect(await resolveRestoreTarget(sm, "u2", hasAny(["u1", "u2"]))).toBe("u2");
});

test("resolveRestoreTarget walks up to the nearest checkpointed ancestor", async () => {
  const sm = tree({ a2: "u2", u2: "a1", a1: "u1", u1: null });
  // Navigating to an assistant entry: the state to restore is the one recorded for
  // the user message that started its turn.
  expect(await resolveRestoreTarget(sm, "a2", hasAny(["u1", "u2"]))).toBe("u2");
});

test("resolveRestoreTarget returns null when nothing on the chain was checkpointed", async () => {
  const sm = tree({ a1: "u1", u1: null });
  expect(await resolveRestoreTarget(sm, "a1", hasAny([]))).toBeNull();
});

test("resolveRestoreTarget handles a null start and an unknown id", async () => {
  const sm = tree({ u1: null });
  expect(await resolveRestoreTarget(sm, null, hasAny(["u1"]))).toBeNull();
  expect(await resolveRestoreTarget(sm, "ghost", hasAny(["u1"]))).toBeNull();
});

test("resolveRestoreTarget does not spin on a malformed cycle", async () => {
  const sm = tree({ a: "b", b: "a" });
  expect(await resolveRestoreTarget(sm, "a", hasAny(["nowhere"]))).toBeNull();
});
