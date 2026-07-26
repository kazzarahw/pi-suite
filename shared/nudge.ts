/**
 * Settle-time nudging — the decision, and the guard that keeps `block` from looping.
 *
 * Two extensions reach `agent_settled` with the same question: given the mode, is there
 * anything to say, and may I trigger another turn to say it? pi-todo answered it first
 * and pi-goal needs the identical answer, so it lives here rather than being copied —
 * the habit `config.ts`, `fields.ts`, and `config-command.ts` all exist to end.
 *
 * What is *not* here is the reminder text. What counts as unfinished work differs per
 * extension (open todos, an unmet objective), so each keeps its own; only the decision
 * and the loop guard are shared.
 */
import type { Mode } from "./mode.ts";

/** What the settle hook should do. `remind` = passive; `continue` = auto-run the agent. */
export type NudgeAction = "none" | "remind" | "continue";

/**
 * Decide the settle-time nudge. Critically returns `"none"` when there is no
 * interactive UI (`-p`/JSON one-shot mode): injecting a message there queues work
 * for a "next prompt" that never comes and stalls Pi's exit.
 */
export function nudgeAction(mode: Mode, hasUI: boolean, hasPending: boolean): NudgeAction {
  if (!hasUI || mode === "off" || !hasPending) return "none";
  return mode === "block" ? "continue" : "remind";
}

/** The no-progress guard returned by {@link createNudgeGuard}. */
export interface NudgeGuard {
  /**
   * May the caller nudge with this state signature? Repeating a signature means the
   * previous nudge produced no progress; once `max` consecutive nudges have gone out
   * against unchanged state this returns `false`, and keeps returning it until the
   * signature changes.
   *
   * `max` is a parameter rather than something the guard closes over because it can come
   * from config, and everything in the suite reads config per call — a limit captured at
   * extension load would ignore the setting the user just changed.
   */
  allow(signature: string, max: number): boolean;
  /** Forget the history — call when there is nothing left to nudge about. */
  reset(): void;
}

/**
 * A guard against auto-continuing forever.
 *
 * `block` mode triggers a fresh turn, which settles, which triggers another. The exit
 * condition cannot be "the work is done", because an agent that is stuck will never
 * finish it; it has to be "nothing changed". `signature` is the caller's snapshot of the
 * state it is nudging about — the same one twice means the last nudge achieved nothing.
 *
 * `max` is how many consecutive nudges one unchanged signature may produce: `2`
 * (pi-todo's long-standing hardcoded value) is the first nudge plus one retry.
 *
 * `lastSignature` starts as `null` rather than `""` so that an empty signature — which
 * a caller could legitimately produce — is not mistaken for a repeat of the initial state.
 */
export function createNudgeGuard(): NudgeGuard {
  let lastSignature: string | null = null;
  let repeats = 0;
  return {
    allow(signature: string, max: number): boolean {
      if (signature === lastSignature) {
        repeats += 1;
        if (repeats >= max) return false;
      } else {
        repeats = 0;
      }
      lastSignature = signature;
      return true;
    },
    reset(): void {
      lastSignature = null;
      repeats = 0;
    },
  };
}
