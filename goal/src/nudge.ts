import type { Goal } from "./state.ts";
import type { TodoProgress, VerifyState } from "./progress.ts";

/**
 * A "the objective is still open" reminder, or `null` when there is nothing to say —
 * no objective, or one already met.
 *
 * The decision of *whether* to deliver this is `nudgeAction` in `shared/nudge.ts`; what
 * counts as unfinished work, and how it is worded, is pi-goal's own.
 *
 * `verify` is named here rather than merely counted because this is the one place the
 * agent may need to *act* on it: an objective still open while the project's checks
 * pass is the exact moment to ask whether the criteria are already satisfied. The
 * wording puts that as a question, not an instruction — passing tests are evidence
 * about the objective, never a decision about it.
 */
export function goalReminder(
  goal: Goal | null,
  progress: TodoProgress | null,
  verify: VerifyState | null,
): string | null {
  if (!goal || goal.status === "met") return null;
  const parts = [`Objective still open: "${goal.objective}".`];
  if (goal.criteria) parts.push(`Met when: ${goal.criteria}.`);
  if (progress) parts.push(`${progress.done} of ${progress.total} todos done.`);
  if (verify) parts.push(`\`${verify.cmd}\` passed — does that satisfy the criteria?`);
  parts.push('Keep going, and call goal_set with status "met" once it is achieved.');
  return parts.join(" ");
}
