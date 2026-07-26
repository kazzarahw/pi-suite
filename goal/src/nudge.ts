import type { Goal } from "./state.ts";
import type { TodoProgress } from "./progress.ts";

/**
 * A "the objective is still open" reminder, or `null` when there is nothing to say —
 * no objective, or one already met.
 *
 * The decision of *whether* to deliver this is `nudgeAction` in `shared/nudge.ts`; what
 * counts as unfinished work, and how it is worded, is pi-goal's own.
 */
export function goalReminder(goal: Goal | null, progress: TodoProgress | null): string | null {
  if (!goal || goal.status === "met") return null;
  const parts = [`Objective still open: "${goal.objective}".`];
  if (goal.criteria) parts.push(`Met when: ${goal.criteria}.`);
  if (progress) parts.push(`${progress.done} of ${progress.total} todos done.`);
  parts.push('Keep going, and call goal_set with status "met" once it is achieved.');
  return parts.join(" ");
}
