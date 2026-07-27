import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { int, oneOf } from "../../shared/fields.ts";

/** pi-goal configuration. */
export interface GoalConfig {
  /** off (tool + widget only) | notify (inject + remind) | block (auto-continue). */
  mode: Mode;
  /**
   * How many times pi-goal may nudge about one objective — reminders in `notify`,
   * auto-continues in `block`. A **quota per objective**, not a no-progress detector.
   *
   * pi-todo can detect no-progress because its signature is its own work product: the
   * list moves as the work moves. pi-goal's state is a *declaration* that only changes
   * when the agent calls `goal`, so there is nothing here that tracking could
   * honestly measure. A quota is the shape that actually terminates, and saying so is
   * better than a "while unmet" promise the mechanism cannot keep.
   */
  maxNudges: number;
}

export const DEFAULTS: GoalConfig = { mode: DEFAULT_MODE, maxNudges: 2 };

export const SPEC: ConfigSpec<GoalConfig> = {
  name: "goal",
  defaults: DEFAULTS,
  parse(raw) {
    const p = raw as Partial<GoalConfig>;
    return {
      mode: oneOf<Mode>(p.mode, MODES, DEFAULT_MODE),
      maxNudges: int(p.maxNudges, DEFAULTS.maxNudges),
    };
  },
};

/** `<agentDir>/pi-goal.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
