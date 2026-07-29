import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODES } from "../../shared/index.ts";
import {
  defineConfigCommand,
  enumField,
  intField,
  type ExtraVerb,
  type Field,
} from "../../shared/config-command.ts";
import type { PlanConfig } from "./config.ts";
import type { Plan } from "./state.ts";

export interface CommandDeps {
  loadConfig: () => PlanConfig;
  saveConfig: (c: PlanConfig) => void;
  getPlan: () => Plan;
  /** Forget the objective and the open list; the log and `seq` survive. */
  clearPlan: (ctx: ExtensionCommandContext) => void;
  /** Forget everything, log included. */
  resetPlan: (ctx: ExtensionCommandContext) => void;
}

export const FIELDS: readonly Field<PlanConfig>[] = [
  enumField("mode", MODES, "Mode"),
  intField("maxNudges", "Nudges per objective", { verb: "nudges", presets: [1, 2, 5] }),
  intField("maxBlocks", "Edit refusals before giving up", { verb: "blocks", presets: [1, 3, 5] }),
];

/** `/pi-plan` — no arg opens the settings panel; `mode` / `nudges` / `blocks` / `clear` / `reset`. */
export function buildPlanCommand(deps: CommandDeps) {
  const describe = (): string => {
    const plan = deps.getPlan();
    if (plan.objective) return `${plan.objective.status}: ${plan.objective.objective}`;
    if (plan.items.length > 0) return `${plan.items.length} open item(s), no objective`;
    return "no plan set";
  };

  // Two verbs rather than one, because they answer different questions.
  //
  // `clear` is "the plan was wrong, re-plan" — and the record of what was already tried
  // and abandoned is exactly what should carry into the re-plan, or the agent is free to
  // re-propose the thing it just dropped. It still fully disarms `block` mode's gate,
  // which arms on an objective or an open item and finds neither afterwards.
  const clear: ExtraVerb = {
    verb: "clear",
    usage: "clear",
    handle: (_value, ctx, notify) => {
      const plan = deps.getPlan();
      if (!plan.objective && plan.items.length === 0) {
        notify.info("nothing to clear");
        return;
      }
      deps.clearPlan(ctx);
      const kept = plan.log.length;
      notify.info(
        kept > 0
          ? `plan cleared — ${kept} log entr${kept === 1 ? "y" : "ies"} kept (use reset to drop those too)`
          : "plan cleared",
      );
    },
  };

  // `reset` is the genuine start-over, and the escape hatch when the log has grown into
  // noise rather than memory.
  const reset: ExtraVerb = {
    verb: "reset",
    usage: "reset",
    handle: (_value, ctx, notify) => {
      deps.resetPlan(ctx);
      notify.info("plan reset — objective, items, and log all forgotten");
    },
  };

  return defineConfigCommand("plan", FIELDS, deps, {
    extraVerbs: [clear, reset],
    // Setting the objective is deliberately not a verb here: that is the agent's job via
    // the `plan` tool. The command configures and overrides; it does not author.
    subtitle: () => `${describe()} · the agent sets this with plan`,
    readoutExtra: () => `plan: ${describe()}`,
    bareValueField: "mode",
  });
}
