import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_STATUSES, applySet, type Goal, type GoalInput } from "./state.ts";
import { renderGoal, type Context } from "./render.ts";
import type { Emitter } from "../../shared/index.ts";

const parameters = Type.Object({
  objective: Type.String({
    description:
      "The single overarching objective this session is working toward, in one sentence. Replaces any previous objective.",
  }),
  criteria: Type.Optional(
    Type.String({
      description:
        "How you will know the objective is met. Omit if the objective speaks for itself; omitting it when restating the same objective keeps whatever was already recorded.",
    }),
  ),
  status: Type.Optional(
    StringEnum(GOAL_STATUSES, {
      description:
        "'active' while work continues, 'met' once the objective is achieved. Defaults to active for a new objective, and to the current status when restating the existing one.",
    }),
  ),
});
type GoalSetParams = Static<typeof parameters>;

/** Dependencies the tool needs; `ctx.ui` comes from the execute `ctx`, not here. */
export interface ToolDeps {
  getState: () => Goal | null;
  setState: (goal: Goal | null) => void;
  emit: Emitter;
  persist: (goal: Goal | null) => void;
  /** Read *after* `setState`, so the turn counter it reports is the reset one. */
  renderContext: () => Context;
}

/** Build the `goal_set` tool: replaces the objective, echoes it, emits events. */
export function buildGoalTool(deps: ToolDeps) {
  return {
    name: "goal_set",
    label: "Goal Set",
    description:
      "Record the single overarching objective for this session — the outcome the work is for, one level above the todo list. Call it when the user states what they want, restate it if the objective changes, and call it again with status 'met' once it is achieved. The objective is kept in context for every turn.",
    promptSnippet:
      "Record the session's overarching objective, and mark it met when achieved.",
    parameters,
    async execute(
      _toolCallId: string,
      params: GoalSetParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ goal: Goal }>> {
      const objective = params.objective.trim();
      // Throwing is the mechanism: Pi sets `isError` only when `execute` throws, and a
      // blank objective stored as the session's north-star is worse than no objective.
      if (!objective) throw new Error("[pi-goal] objective must not be blank");

      const incoming: GoalInput = { objective };
      const criteria = params.criteria?.trim();
      if (criteria) incoming.criteria = criteria;
      if (params.status) incoming.status = params.status as GoalInput["status"];

      const { goal, newlyMet } = applySet(deps.getState(), incoming);
      deps.setState(goal);
      deps.persist(goal);

      const set: { objective: string; criteria?: string } = { objective: goal.objective };
      if (goal.criteria) set.criteria = goal.criteria;
      deps.emit("goal:set", set);
      if (newlyMet) deps.emit("goal:met", { objective: goal.objective });

      const lines = renderGoal(goal, deps.renderContext());
      ctx?.ui?.setWidget?.("goal", lines);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { goal } };
    },
  };
}
