import { injectionBlock } from "../../shared/index.ts";
import type { Goal, GoalStatus } from "./state.ts";
import type { TodoProgress } from "./progress.ts";

const MARKERS: Record<GoalStatus, string> = {
  active: "▸",
  met: "✓",
};

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The state the objective is rendered against: how long it has stood, and how the todo
 * list is tracking. Both optional — neither is required for the objective to be useful.
 */
export interface Context {
  turns: number;
  progress: TodoProgress | null;
}

/** `4 turns · 2 of 5 todos done`, or `""` when there is nothing worth saying. */
function annotate(ctx: Context): string {
  const parts: string[] = [];
  // Zero turns is not "just set" — it is also what a restore reports, since the counter
  // is in memory and does not survive a fork. Saying nothing is honest; "0 turns" is not.
  if (ctx.turns > 0) parts.push(`${ctx.turns} turn${ctx.turns === 1 ? "" : "s"}`);
  if (ctx.progress) parts.push(`${ctx.progress.done} of ${ctx.progress.total} todos done`);
  return parts.join(" · ");
}

/**
 * Widget lines: the objective, and its annotation when there is one.
 *
 * The criteria are deliberately not shown here. They are the agent's checklist, and the
 * widget is a glance — the full form goes into the injection below.
 */
export function renderGoal(goal: Goal, ctx: Context): string[] {
  const lines = [`${MARKERS[goal.status]} ${truncate(goal.objective, 88)}`];
  const note = annotate(ctx);
  if (note) lines.push(`  ${note}`);
  return lines;
}

/**
 * The `<pi-goal>` context block for the agent, or `""` when there is nothing standing.
 *
 * **This must stay byte-identical for as long as the objective is unchanged**, which is
 * why it takes no {@link Context} and carries no turn count or todo tally. The block is
 * prepended to every LLM call and therefore sits at message index 0, while the provider
 * puts the conversation-history cache breakpoint on the *last* user message — so a cache
 * hit needs the whole prefix to match. An annotation that ticks over each turn would
 * invalidate the entire conversation cache on every single call, in exactly the long
 * sessions this extension exists to serve. The volatile parts belong in the widget,
 * which is free. pi-memory's index injection is stable within a session for the same
 * reason.
 *
 * A met objective is not injected either: it is finished, and restating it for the rest
 * of the session costs context on every call and buys nothing. The widget keeps the `✓`.
 */
export function formatInjection(goal: Goal | null): string {
  if (!goal || goal.status === "met") return "";
  const body = [`${MARKERS[goal.status]} ${goal.objective}`];
  if (goal.criteria) body.push(`  met when: ${goal.criteria}`);
  return injectionBlock("goal", "goal · current objective", body.join("\n"));
}
