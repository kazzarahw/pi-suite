import type { Emitter } from "../../shared/index.ts";
import type { CheckpointStore } from "./store.ts";

/** pi-git's emitter. Aliased for readability; the contract is shared/events.ts. */
export type Emit = Emitter;

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

export interface GuardSummary {
  /** Paths whose pre-delegation state is now recorded (or already was). */
  recorded: number;
  /** Paths left out because the working set exceeded `maxGuardedFiles`. */
  skipped: number;
}

/**
 * Record the working set before a delegated subagent runs.
 *
 * pi-git learns a file's pre-edit bytes from `tool_call`, which fires in this process.
 * A subagent edits from *its own* `pi` process, so those writes are invisible here: a
 * file that was clean when the delegation started has no origin, is in no manifest, and
 * a rewind past the delegation leaves it modified while reporting success. That is the
 * failure pi-git exists to prevent, occurring in the case the user watched least.
 *
 * Since which files a subagent will touch is unknowable in advance, this records the
 * ones it *can* — the tracked tree plus whatever is already dirty. `rememberOrigin`
 * never overwrites, so this is idempotent: the first guarded delegation in a session
 * pays for the tree, and every later one is a no-op over paths already held.
 *
 * Returns what it did rather than reporting for itself, so the caller owns the one
 * channel that reaches the user.
 */
export async function guardDelegation(
  store: CheckpointStore,
  paths: readonly string[],
  maxFiles: number,
): Promise<GuardSummary> {
  const guarded = paths.slice(0, maxFiles);
  for (const path of guarded) {
    // One failure must not abandon the rest: a single unreadable file is not a reason
    // to leave the other four thousand unguarded.
    try {
      await store.rememberOrigin(path);
    } catch {
      /* best effort, per path */
    }
  }
  return { recorded: guarded.length, skipped: paths.length - guarded.length };
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
