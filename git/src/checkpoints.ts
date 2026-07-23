import type { Git } from "./git.ts";

/** Private ref namespace: the ref name encodes the entry id, so it's also the map. */
const CHECKPOINT_PREFIX = "refs/pi-git/checkpoints/";

export interface Checkpoint {
  entryId: string;
  ref: string;
  sha: string;
  reason: string;
  createdAtIso: string;
}

export function checkpointRef(entryId: string): string {
  return `${CHECKPOINT_PREFIX}${entryId}`;
}

/** The minimal session-manager surface we read (keeps this unit testable). */
interface EntryLike {
  type?: string;
  id?: string;
  message?: { role?: string };
}
interface SessionManagerLike {
  getLeafEntry?: () => EntryLike | undefined;
  getBranch?: () => EntryLike[];
}

/**
 * The id of the user message that started the current turn — the leaf entry when
 * `before_agent_start` fires, with a backward scan of the branch as a fallback.
 * Same id space as `session_before_fork.entryId`.
 */
export function currentUserEntryId(sm: SessionManagerLike): string | null {
  const isUser = (e: EntryLike | undefined): e is EntryLike =>
    !!e && e.type === "message" && e.message?.role === "user" && typeof e.id === "string";

  const leaf = sm.getLeafEntry?.();
  if (isUser(leaf)) return leaf.id!;

  const branch = sm.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    if (isUser(branch[i])) return branch[i]!.id!;
  }
  return null;
}

/** Snapshot the working tree and store it under the entry's checkpoint ref. */
export async function checkpoint(
  git: Git,
  entryId: string,
  reason: string,
  nowIso: string,
): Promise<Checkpoint> {
  const sha = await git.snapshotTree(reason);
  const ref = checkpointRef(entryId);
  await git.updateRef(ref, sha);
  return { entryId, ref, sha, reason, createdAtIso: nowIso };
}

/** Look up a checkpoint by entry id — a direct ref read (the ref name is the map). */
export async function findCheckpoint(git: Git, entryId: string): Promise<Checkpoint | null> {
  const ref = checkpointRef(entryId);
  const sha = await git.readRef(ref);
  return sha ? { entryId, ref, sha, reason: "", createdAtIso: "" } : null;
}

/** Restore the working tree to a checkpoint. */
export async function restoreTo(git: Git, cp: Checkpoint): Promise<void> {
  await git.restoreTree(cp.sha);
}
