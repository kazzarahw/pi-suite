/**
 * Per-session state for pi-git's hooks.
 *
 * Six hooks shared four module-level mutables — a cached store, a queue of skipped
 * files, a set of already-announced paths, and the last checkpointed entry id — each
 * written by one hook and read by another. Nothing was wrong with the values; the
 * problem was that `storeFor` mutated the cache as a side effect of being asked a
 * question, and `reportSkips` drained a queue, marked a set, and chose between two
 * output channels in one pass. Neither could be exercised without driving a hook.
 *
 * Grouped here so the hooks in `index.ts` read as intent, and so the awkward parts —
 * cache invalidation, announce-once — are testable directly.
 */
import { createStore, type CheckpointStore } from "./store.ts";

/** A file left out of a checkpoint because it exceeded the size cap. */
export interface Skip {
  path: string;
  bytes: number;
}

/** What Pi tells us about the session. Structural, so a test can pass a plain object. */
export interface SessionSource {
  sessionManager?: { getSessionId?: () => string };
}

export interface GitSession {
  /**
   * The store for this session, rebuilt only when the session id or the size cap
   * changes. `null` when there is no session to key on — nothing could be restored
   * later, so there is nothing worth recording now.
   */
  store(ctx: SessionSource | undefined, maxFileBytes: number): CheckpointStore | null;
  /**
   * The store the most recent hook built, without needing a context.
   *
   * For **bus callbacks only**, which are handed `data` and nothing else — no
   * `ExtensionContext`, so no `getSessionId`, so no way to key a store. `null` before
   * any hook has run, which is the honest answer: nothing has been checkpointed yet, so
   * there is nothing a subscriber could be extending.
   *
   * Safe against a session change because Pi fires `session_start` for the new session
   * before anything in it can emit, and that hook rebuilds the cache.
   */
  currentStore(): CheckpointStore | null;
  /** Skips recorded since the last drain, each path reported at most once per session. */
  drainSkips(): Skip[];
  /** The entry id most recently checkpointed, for turn-level dedup. */
  lastCheckpointed(): string | null;
  markCheckpointed(entryId: string | null): void;
}

export function createGitSession(
  makeStore: typeof createStore = createStore,
): GitSession {
  let cached: { sessionId: string; maxFileBytes: number; store: CheckpointStore } | null = null;
  let lastEntryId: string | null = null;
  const skipped: Skip[] = [];
  const announced = new Set<string>();

  return {
    store(ctx, maxFileBytes) {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      if (!sessionId) return null;
      if (cached && cached.sessionId === sessionId && cached.maxFileBytes === maxFileBytes) {
        return cached.store;
      }
      const store = makeStore(sessionId, {
        maxFileBytes,
        onSkip: (path, bytes) => skipped.push({ path, bytes }),
      });
      cached = { sessionId, maxFileBytes, store };
      return store;
    },

    currentStore: () => cached?.store ?? null,

    drainSkips() {
      // Deduped on the way out, not on the way in: the store reports a skip on every
      // checkpoint, and a large file is skipped on all of them. Announcing each once is
      // the difference between a warning and a stream of them.
      const fresh: Skip[] = [];
      for (const skip of skipped.splice(0)) {
        if (announced.has(skip.path)) continue;
        announced.add(skip.path);
        fresh.push(skip);
      }
      return fresh;
    },

    lastCheckpointed: () => lastEntryId,
    markCheckpointed(entryId) {
      lastEntryId = entryId;
    },
  };
}
