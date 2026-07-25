import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import {
  configPath as sharedConfigPath,
  loadConfig as sharedLoad,
  saveConfig as sharedSave,
  type ConfigSpec,
} from "../../shared/config.ts";
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

/** `<agentDir>/pi-todo.json`. */
export function configPath(): string {
  return sharedConfigPath(SPEC.name);
}

/** Read the config, falling back to {@link DEFAULTS} for any missing/invalid field. */
export function loadConfig(path?: string): TodoConfig {
  return sharedLoad(SPEC, path);
}

/** Write the config, creating the parent directory if needed. */
export function saveConfig(cfg: TodoConfig, path?: string): void {
  sharedSave(SPEC, cfg, path);
}
