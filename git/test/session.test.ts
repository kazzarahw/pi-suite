import { test, expect } from "bun:test";
import { createGitSession, type SessionSource } from "../src/session.ts";
import type { CheckpointStore, createStore } from "../src/store.ts";

type MakeStore = typeof createStore;

/**
 * pi-git's per-session state.
 *
 * These were module-level mutables shared by six hooks: `storeFor` rebuilt and cached as
 * a side effect of being asked a question, and `reportSkips` drained a queue, marked a
 * set, and picked an output channel in one pass. Neither could be reached without firing
 * a hook, so the cache-invalidation and announce-once rules — the two easiest things to
 * get wrong — were never directly exercised.
 */

const stub = (id: string): CheckpointStore =>
  ({ id }) as unknown as CheckpointStore;

/** A fake `createStore` that records its arguments and hands back a labelled stub. */
function recorder() {
  const calls: Array<{ sessionId: string; maxFileBytes?: number }> = [];
  const make = ((sessionId: string, opts?: { maxFileBytes?: number; onSkip?: (p: string, b: number) => void }) => {
    calls.push({ sessionId, maxFileBytes: opts?.maxFileBytes });
    return { store: stub(`${sessionId}:${opts?.maxFileBytes}`), onSkip: opts?.onSkip };
  }) as unknown as MakeStore;
  return { calls, make };
}

const src = (sessionId?: string): SessionSource =>
  sessionId === undefined ? {} : { sessionManager: { getSessionId: () => sessionId } };

test("no session id means no store — there would be nothing to restore from", () => {
  const session = createGitSession();
  expect(session.store(src(), 100)).toBeNull();
  expect(session.store(undefined, 100)).toBeNull();
});

test("the store is built once and reused for the same session and cap", () => {
  const { calls, make } = recorder();
  const session = createGitSession(make);
  const first = session.store(src("s1"), 100);
  const second = session.store(src("s1"), 100);
  expect(first).toBe(second);
  expect(calls).toHaveLength(1);
});

test("a new session id rebuilds the store", () => {
  const { calls, make } = recorder();
  const session = createGitSession(make);
  session.store(src("s1"), 100);
  session.store(src("s2"), 100);
  expect(calls.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
});

test("a changed size cap rebuilds the store", () => {
  // The cap is baked into the store at construction, so a config change that is not
  // noticed here would go on silently skipping files at the old threshold.
  const { calls, make } = recorder();
  const session = createGitSession(make);
  session.store(src("s1"), 100);
  session.store(src("s1"), 200);
  expect(calls.map((c) => c.maxFileBytes)).toEqual([100, 200]);
});

test("returning to a previous session rebuilds rather than serving a stale store", () => {
  const { calls, make } = recorder();
  const session = createGitSession(make);
  session.store(src("s1"), 100);
  session.store(src("s2"), 100);
  session.store(src("s1"), 100);
  expect(calls).toHaveLength(3);
});

// --- skips ----------------------------------------------------------------

/** Build a session and return the `onSkip` callback the store was handed. */
function withSkips() {
  let onSkip: ((p: string, b: number) => void) | undefined;
  const make = ((_id: string, opts?: { onSkip?: (p: string, b: number) => void }) => {
    onSkip = opts?.onSkip;
    return {} as CheckpointStore;
  }) as unknown as MakeStore;
  const session = createGitSession(make);
  session.store(src("s1"), 100);
  return { session, skip: (p: string, b: number) => onSkip?.(p, b) };
}

test("a skip recorded by the store comes back from drainSkips", () => {
  const { session, skip } = withSkips();
  skip("/big.bin", 999);
  expect(session.drainSkips()).toEqual([{ path: "/big.bin", bytes: 999 }]);
});

test("draining empties the queue", () => {
  const { session, skip } = withSkips();
  skip("/big.bin", 999);
  session.drainSkips();
  expect(session.drainSkips()).toEqual([]);
});

test("a path is announced once, however many checkpoints skip it", () => {
  // The store reports the skip on every checkpoint, and a large file is skipped on all
  // of them. Without this, one oversized file warns on every turn for the whole session.
  const { session, skip } = withSkips();
  skip("/big.bin", 999);
  expect(session.drainSkips()).toHaveLength(1);
  skip("/big.bin", 999);
  expect(session.drainSkips()).toEqual([]);
});

test("a different path still announces after an earlier one was announced", () => {
  const { session, skip } = withSkips();
  skip("/a.bin", 1);
  session.drainSkips();
  skip("/b.bin", 2);
  expect(session.drainSkips()).toEqual([{ path: "/b.bin", bytes: 2 }]);
});

test("several distinct skips drain together, in the order recorded", () => {
  const { session, skip } = withSkips();
  skip("/a.bin", 1);
  skip("/b.bin", 2);
  expect(session.drainSkips().map((s) => s.path)).toEqual(["/a.bin", "/b.bin"]);
});

// --- turn dedup -----------------------------------------------------------

test("the last checkpointed entry starts unset", () => {
  expect(createGitSession().lastCheckpointed()).toBeNull();
});

test("marking an entry records it, and null clears it", () => {
  // `session_tree` clears it: the timeline moved, so the next turn must checkpoint even
  // if its entry id happens to repeat.
  const session = createGitSession();
  session.markCheckpointed("e1");
  expect(session.lastCheckpointed()).toBe("e1");
  session.markCheckpointed(null);
  expect(session.lastCheckpointed()).toBeNull();
});
