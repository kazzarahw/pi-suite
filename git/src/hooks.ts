import type { CheckpointStore } from "./store.ts";

export type Emit = (event: string, data: unknown) => void;

/** What `session_before_fork` records, for `session_shutdown` to act on. */
export interface PendingFork {
  entryId: string;
  position: string;
}

export interface CheckpointSummary {
  entryId: string;
  files: number;
}

export interface RestoreSummary {
  entryId: string;
  written: number;
  removed: number;
}

/**
 * Record the state of `paths` against a session entry.
 * The caller resolves the entry id and decides which paths are in scope.
 */
export async function checkpointTurn(
  store: CheckpointStore,
  entryId: string,
  paths: readonly string[],
  reason: string,
  emit: Emit,
): Promise<CheckpointSummary> {
  const manifest = await store.checkpoint(entryId, paths);
  const summary = { entryId, files: Object.keys(manifest).length };
  emit("git:checkpoint", { ...summary, reason });
  return summary;
}

/**
 * Put the files back to their state at `entryId`. `null` when nothing was ever
 * checkpointed there — reported rather than swallowed, so a rewind that cannot
 * restore anything does not look like one that restored nothing.
 */
export async function restoreEntry(
  store: CheckpointStore,
  entryId: string | null,
  reason: string,
  emit: Emit,
): Promise<RestoreSummary | null> {
  if (!entryId || !(await store.has(entryId))) return null;
  const { written, removed } = await store.restore(entryId);
  const summary = { entryId, written: written.length, removed: removed.length };
  emit("git:rollback", { ...summary, reason });
  return summary;
}

/**
 * Restore on a committing fork. Only acts when the shutdown reason is `"fork"`, a
 * `"before"`-position fork is pending, and a checkpoint exists for its entry.
 * A `"at"` (clone) fork, a cancelled fork (no shutdown), or a missing checkpoint → no-op.
 */
export async function restoreOnForkShutdown(
  store: CheckpointStore,
  pending: PendingFork | null,
  shutdownReason: string,
  emit: Emit,
): Promise<RestoreSummary | null> {
  if (shutdownReason !== "fork" || !pending || pending.position !== "before") return null;
  return restoreEntry(store, pending.entryId, "rewind", emit);
}
