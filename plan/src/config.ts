import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { int, oneOf } from "../../shared/fields.ts";

/** pi-plan configuration. */
export interface PlanConfig {
  /**
   * off (tool + widget only) | notify (inject + remind) | block (auto-continue AND refuse
   * unplanned edits).
   *
   * pi-plan is the first extension where `block` takes **both** documented shapes at once
   * — Interdict on `tool_call`, Insist on `agent_settled`. That is one dial rather than
   * two because they are one intent: at `block`, the user is saying the plan is binding.
   * Splitting them would offer a combination nobody wants (refuse edits but never mention
   * why, or nag without ever stopping anything) and make the dial mean something different
   * here than everywhere else in the suite.
   */
  mode: Mode;
  /**
   * How many times pi-plan may nudge about one **objective** — reminders in `notify`,
   * auto-continues in `block`. A quota per objective, not a no-progress detector.
   *
   * The distinction is pi-goal's and it survives the merge intact. Item state can carry a
   * no-progress detector because it *is* the work product: the list moves as the work
   * moves. An objective is a declaration that changes only when the agent restates it, so
   * there is nothing there that progress-tracking could honestly measure, and a quota is
   * the shape that actually terminates.
   */
  maxNudges: number;
  /**
   * How many consecutive edits `block` mode may refuse before giving up and letting one
   * through with a notice.
   *
   * `shared/mode.ts` is absolute that `block` never acts without a bound, and an
   * interdiction needs one more than an insistence does: an agent that cannot work out
   * what the gate wants would otherwise be unable to edit anything for the rest of the
   * session, with no way out but the settings panel.
   */
  maxBlocks: number;
}

export const DEFAULTS: PlanConfig = { mode: DEFAULT_MODE, maxNudges: 2, maxBlocks: 3 };

export const SPEC: ConfigSpec<PlanConfig> = {
  name: "plan",
  defaults: DEFAULTS,
  parse(raw) {
    const p = raw as Partial<PlanConfig>;
    return {
      mode: oneOf<Mode>(p.mode, MODES, DEFAULT_MODE),
      maxNudges: int(p.maxNudges, DEFAULTS.maxNudges),
      maxBlocks: int(p.maxBlocks, DEFAULTS.maxBlocks),
    };
  },
};

/** `<agentDir>/pi-plan.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
