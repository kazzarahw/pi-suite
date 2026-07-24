import type { Git } from "./git.ts";
import { checkpoint, findCheckpoint, restoreTo, type Checkpoint } from "./checkpoints.ts";

export type Emit = (event: string, data: unknown) => void;

/** What `session_before_fork` records, for `session_shutdown` to act on. */
export interface PendingFork {
  entryId: string;
  position: string;
}

/**
 * Checkpoint the working tree for the current turn, keyed to its user-message entry id.
 * The caller resolves the entry id (via `currentUserEntryId`) and dedups per turn.
 */
export async function checkpointTurn(
  git: Git,
  entryId: string,
  reason: string,
  nowIso: string,
  emit: Emit,
): Promise<Checkpoint> {
  const cp = await checkpoint(git, entryId, reason, nowIso);
  emit("git:checkpoint", { ref: cp.ref, reason });
  return cp;
}

/**
 * Restore on a committing fork. Only acts when the shutdown reason is `"fork"`, a
 * `"before"`-position fork is pending, and a checkpoint exists for its entry.
 * A `"at"` (clone) fork, a cancelled fork (no shutdown), or a missing checkpoint → no-op.
 */
export async function restoreOnForkShutdown(
  git: Git,
  pending: PendingFork | null,
  shutdownReason: string,
  emit: Emit,
): Promise<Checkpoint | null> {
  if (shutdownReason !== "fork" || !pending || pending.position !== "before") return null;
  const cp = await findCheckpoint(git, pending.entryId);
  if (!cp) return null;
  await restoreTo(git, cp);
  emit("git:rollback", { ref: cp.ref, reason: "rewind" });
  return cp;
}
