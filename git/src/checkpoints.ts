/**
 * Reading Pi's session tree.
 *
 * Everything here is about *which entry id* a checkpoint belongs to. What a
 * checkpoint contains lives in `store.ts`; nothing in this file touches the
 * filesystem, which is what keeps it testable against a plain object.
 */

/** The minimal session-manager surface we read (keeps this unit testable). */
interface EntryLike {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: { role?: string };
}

export interface SessionManagerLike {
  getLeafEntry?: () => EntryLike | undefined;
  getLeafId?: () => string | null;
  getBranch?: () => EntryLike[];
  getEntry?: (id: string) => EntryLike | undefined;
}

/**
 * The id of the user message that started the current turn — the leaf entry when
 * `message_start` fires, with a backward scan of the branch as a fallback.
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

/** Where the conversation currently sits, whatever kind of entry that is. */
export function currentLeafId(sm: SessionManagerLike): string | null {
  return sm.getLeafId?.() ?? sm.getLeafEntry?.()?.id ?? null;
}

/** A session tree is not deep enough to justify an unbounded walk. */
export const MAX_ANCESTOR_WALK = 1024;

/**
 * The nearest checkpointed entry at or above `startId`.
 *
 * Navigation reports a **leaf** id, and only some entries carry a checkpoint: a user
 * message (checkpointed at `message_start`, holding the state as that message was
 * sent) and whatever leaf the session was sitting on when it navigated away
 * (checkpointed at `session_before_tree`, holding the state being left behind).
 * Walking up from the destination finds whichever applies, which is what makes
 * navigating forward restore the later state and navigating back restore the earlier
 * one — without either overwriting the other.
 */
export async function resolveRestoreTarget(
  sm: SessionManagerLike,
  startId: string | null,
  has: (entryId: string) => Promise<boolean>,
): Promise<string | null> {
  let id: string | null | undefined = startId;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_ANCESTOR_WALK && id; i++) {
    if (seen.has(id)) return null; // a malformed cycle must not spin
    seen.add(id);
    if (await has(id)) return id;
    id = sm.getEntry?.(id)?.parentId ?? null;
  }
  return null;
}
