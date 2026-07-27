/**
 * The session's objective, and the reducer that replaces it.
 *
 * `Goal` stays local to pi-goal rather than moving to `shared/events.ts`: the bus
 * payloads carry plain strings, so no other extension needs the type. `TodoItem` lives
 * in shared only because `todo:updated` genuinely carries one.
 */

/**
 * The objective's statuses, in order. Feed into `StringEnum(GOAL_STATUSES)` when
 * building the tool schema so the wire enum stays in sync with {@link GoalStatus}.
 */
export const GOAL_STATUSES = ["active", "met"] as const;

/** Status of the session objective. */
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** The one objective the session is working toward. */
export interface Goal {
  /** The objective itself, in one sentence. */
  objective: string;
  /** How the agent will know it is met. Absent when the objective speaks for itself. */
  criteria?: string;
  status: GoalStatus;
}

/** A goal as supplied by the agent: `status` optional, defaulting to `active`. */
export interface GoalInput {
  objective: string;
  criteria?: string;
  status?: GoalStatus;
}

/** Result of a full replace. */
export interface ApplyResult {
  goal: Goal;
  /** The objective transitioned to `met` in this write (drives `goal:met`). */
  newlyMet: boolean;
}

/**
 * Replace the objective. Pure and deterministic — no clock, so tests reproduce.
 *
 * Rules beyond the plain replace, all keyed on the objective text, which is the only
 * identity a goal has:
 *
 * - **Omitted fields carry forward** across a restatement of the same objective. Marking
 *   a goal met is the common second call and should not have to repeat the criteria to
 *   keep them; equally, restating an objective to amend its criteria must not quietly
 *   reopen one already met. Both directions matter, so `status` carries the same way
 *   `criteria` does — an earlier version carried only `criteria`, and the asymmetry made
 *   `goal({ objective })` on a met goal a silent regression to `active`. Reopening
 *   is still available; it just has to be said, with an explicit `status: "active"`.
 *   Same shape as pi-todo preserving an item's id when it is resent by content.
 * - **`newlyMet` is idempotent against the state it is given.** Restating an already-met
 *   objective reports nothing, so a repeated call cannot emit `goal:met` twice. It is a
 *   property of this function, not a session-wide guarantee: a restore that replaces the
 *   caller's in-memory goal legitimately starts the comparison over.
 */
export function applySet(prev: Goal | null, incoming: GoalInput): ApplyResult {
  const restated = prev !== null && prev.objective === incoming.objective;
  const criteria = incoming.criteria ?? (restated ? prev.criteria : undefined);
  const status = incoming.status ?? (restated ? prev.status : "active");

  const goal: Goal = { objective: incoming.objective, status };
  if (criteria) goal.criteria = criteria;

  const newlyMet = goal.status === "met" && !(restated && prev.status === "met");
  return { goal, newlyMet };
}
