import { oneOf } from "../../shared/fields.ts";
import { GOAL_STATUSES, type Goal, type GoalStatus } from "./state.ts";

/** Custom-entry type used to persist the objective in the session (not sent to the LLM). */
const ENTRY_TYPE = "goal-state";

interface AppendCapable {
  appendEntry: (customType: string, data?: unknown) => void;
}

interface BranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}
interface RestoreCtx {
  sessionManager?: { getBranch: () => BranchEntry[] } | null;
}

/** Persist the objective as a `goal-state` custom entry. `null` records a clear. */
export function appendState(pi: AppendCapable, goal: Goal | null): void {
  pi.appendEntry(ENTRY_TYPE, { goal });
}

/**
 * Rebuild the objective from the most recent `goal-state` entry in the branch.
 *
 * Returns `null` when there is none, and also when the most recent one recorded a clear
 * — the newest entry wins, so `/pi-goal clear` survives a fork rather than being undone
 * by the older entry sitting behind it.
 */
export function restoreState(ctx: RestoreCtx): Goal | null {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry && entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      const data = entry.data as { goal?: Partial<Goal> | null } | undefined;
      const goal = data?.goal;
      if (!goal || typeof goal.objective !== "string") return null;
      // Validated, not trusted. This is the one place pi-goal reads state it did not
      // just construct, and an unrecognised status reaches `MARKERS[status]` — which
      // yields `undefined` and puts the literal string into the agent's context rather
      // than failing. A hand-edited session file or a version that once wrote a third
      // status is all it takes.
      const restored: Goal = {
        objective: goal.objective,
        status: oneOf<GoalStatus>(goal.status, GOAL_STATUSES, "active"),
      };
      if (typeof goal.criteria === "string" && goal.criteria) restored.criteria = goal.criteria;
      return restored;
    }
  }
  return null;
}
