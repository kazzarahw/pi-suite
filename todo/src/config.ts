import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODE, MODES, type Mode } from "pi-shared";

/** pi-todo configuration. */
export interface TodoConfig {
  /** The nudge mode: off (widget only) | notify (remind) | block (auto-continue). */
  mode: Mode;
}

export const DEFAULTS: TodoConfig = { mode: DEFAULT_MODE };

/** `~/.pi/agent/pi-todo.json`. */
export function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-todo.json");
}

/** Read the config, falling back to {@link DEFAULTS} for any missing/invalid field. */
export function loadConfig(path: string = configPath()): TodoConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TodoConfig>;
    const mode = (MODES as readonly string[]).includes(parsed.mode as string)
      ? (parsed.mode as Mode)
      : DEFAULT_MODE;
    return { mode };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write the config, creating the parent directory if needed. */
export function saveConfig(cfg: TodoConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
