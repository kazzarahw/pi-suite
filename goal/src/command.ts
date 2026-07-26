import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODES } from "../../shared/index.ts";
import {
  defineConfigCommand,
  enumField,
  intField,
  type ExtraVerb,
  type Field,
} from "../../shared/config-command.ts";
import type { GoalConfig } from "./config.ts";
import type { Goal } from "./state.ts";

export interface CommandDeps {
  loadConfig: () => GoalConfig;
  saveConfig: (c: GoalConfig) => void;
  getGoal: () => Goal | null;
  clearGoal: (ctx: ExtensionCommandContext) => void;
}

export const FIELDS: readonly Field<GoalConfig>[] = [
  enumField("mode", MODES, "Mode"),
  intField("maxNudges", "Nudges per objective", { verb: "nudges", presets: [1, 2, 5] }),
];

/** `/pi-goal` — no arg opens the settings panel; `mode` / `nudges` / `clear`. */
export function buildGoalCommand(deps: CommandDeps) {
  // Clearing the objective is an action on session state, not a setting — it has no
  // value to display or cycle, so it stays a verb rather than joining the field table.
  // Setting the objective is deliberately *not* here: that is the agent's job, via
  // `goal_set`. The command configures and overrides; it does not author.
  const clear: ExtraVerb = {
    verb: "clear",
    usage: "clear",
    handle: (_value, ctx, notify) => {
      if (!deps.getGoal()) {
        notify.info("no objective set");
        return;
      }
      deps.clearGoal(ctx);
      notify.info("objective cleared");
    },
  };

  const describe = (): string => {
    const goal = deps.getGoal();
    return goal ? `${goal.status}: ${goal.objective}` : "no objective set";
  };

  return defineConfigCommand("goal", FIELDS, deps, {
    extraVerbs: [clear],
    subtitle: () => `${describe()} · the agent sets this with goal_set`,
    readoutExtra: () => `objective: ${describe()}`,
    bareValueField: "mode",
  });
}
