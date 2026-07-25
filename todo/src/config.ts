import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { oneOf } from "../../shared/fields.ts";

/** pi-todo configuration. */
export interface TodoConfig {
  /** The nudge mode: off (widget only) | notify (remind) | block (auto-continue). */
  mode: Mode;
}

export const DEFAULTS: TodoConfig = { mode: DEFAULT_MODE };

export const SPEC: ConfigSpec<TodoConfig> = {
  name: "todo",
  defaults: DEFAULTS,
  parse(raw) {
    const p = raw as Partial<TodoConfig>;
    return { mode: oneOf<Mode>(p.mode, MODES, DEFAULT_MODE) };
  },
};

/** `<agentDir>/pi-todo.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
