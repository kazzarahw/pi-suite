import type { Emitter } from "../../shared/index.ts";
import type { CheckpointStore, Heads } from "./store.ts";

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
  /** Where the repositories pointed when this entry was checkpointed. `{}` if unrecorded. */
  heads: Heads;
}

/**
 * Record the state of `paths` against a session entry.
 * The caller resolves the entry id, decides which paths are in scope, and reads the heads.
 */
export async function checkpointTurn(
  store: CheckpointStore,
  entryId: string,
  paths: readonly string[],
  reason: string,
  emit: Emit,
  heads?: Heads,
): Promise<CheckpointSummary> {
  const manifest = await store.checkpoint(entryId, paths, heads);
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
  const { written, removed, heads } = await store.restore(entryId);
  const summary = { entryId, written: written.length, removed: removed.length };
  emit("git:rollback", { ...summary, reason });
  return { ...summary, heads };
}

/**
 * What a restore did, in one line — or `null` when it did nothing worth saying.
 *
 * pi-git used to be silent on success and speak only on failure, which is backwards: a
 * rewind that rewrote six files and said nothing is indistinguishable from one that did
 * not run, and that ambiguity is what made a working restore read as a broken one.
 */
export function describeRestore(summary: RestoreSummary): string | null {
  const parts: string[] = [];
  if (summary.written > 0) parts.push(`${summary.written} file(s) restored`);
  if (summary.removed > 0) parts.push(`${summary.removed} removed`);
  return parts.length > 0 ? `[pi-git] ${parts.join(", ")}.` : null;
}

/**
 * The warning for a `HEAD` that moved between checkpoint and restore, or `null`.
 *
 * The store puts files back and never touches a ref, so a session that committed leaves
 * the two disagreeing: the bytes are at the checkpoint, `HEAD` is still at the agent's
 * last commit, and `git status` reports a working tree that reverts its own history. The
 * user reads that as "the rewind did nothing" — the files look modified, the commits are
 * all still in the log — when in fact it did exactly what it promised.
 *
 * Only ever produced from a difference actually observed. A repository this never saw,
 * or one whose HEAD is unchanged, produces nothing; silence is never a claim that
 * nothing moved. Pure, so the wording is testable without a repository.
 */
export function describeHeadDrift(recorded: Heads, current: Heads): string | null {
  const moved: string[] = [];
  for (const [root, was] of Object.entries(recorded)) {
    const now = current[root];
    if (now && now !== was) moved.push(`${root} is at ${now.slice(0, 8)}, was ${was.slice(0, 8)}`);
  }
  if (moved.length === 0) return null;
  return (
    `[pi-git] your files are back, but HEAD moved during this session — ${moved.join("; ")}. ` +
    `pi-git restores files and never moves a ref, so those commits are still in the log ` +
    `and your working tree now reads as a revert of them. \`git reset --hard <was>\` drops them; ` +
    `\`git checkout -- .\` keeps them and discards the restore.`
  );
}

export interface GuardSummary {
  /** Paths whose pre-delegation state is now recorded (or already was). */
  recorded: number;
  /** Paths left out because the working set exceeded `maxGuardedFiles`. */
  skipped: number;
}

/**
 * Record the working set before something pi-git cannot watch changes it.
 *
 * pi-git learns a file's pre-edit bytes from `tool_call` on the *edit* tools, which name
 * the path they are about to touch. Two things change files without ever doing that:
 *
 *   - **A delegated subagent**, which edits from its own `pi` process, so its writes
 *     never reach this process's hooks at all.
 *   - **`bash`**, whose input is an opaque command string — a `sed -i`, a heredoc, a
 *     `git apply`, a plain `>` redirect. Nothing in the input says which files it means.
 *
 * Both had the same failure: a file that was clean when the turn began had no origin, was
 * in no manifest, and survived a rewind untouched while pi-git reported success. The
 * `detectDirty` sweep does not close it, because it runs at *checkpoint* time — by then
 * the modified bytes are all that is left to record, and they get stored as the original.
 *
 * Since which files will be touched is unknowable in advance, this records the ones that
 * *can* be — the tracked tree plus whatever is already dirty. `rememberOrigins` never
 * overwrites, so it is idempotent: the first guarded call in a session pays for the tree,
 * and every later one is a no-op over paths already held.
 *
 * Returns what it did rather than reporting for itself, so the caller owns the one
 * channel that reaches the user.
 */
export async function guardWorkingSet(
  store: CheckpointStore,
  paths: readonly string[],
  maxFiles: number,
): Promise<GuardSummary> {
  const guarded = paths.slice(0, maxFiles);
  // Batched: the per-path form re-reads the origin file each time, which is free for one
  // path and quadratic for a whole tree. Per-path failures are contained inside.
  try {
    await store.rememberOrigins(guarded);
  } catch {
    /* best effort — a guard that throws must not take the turn with it */
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
