import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pi-consult configuration, persisted as JSON and read per call. */
export interface ConsultConfig {
  /** Model alias passed to `claude --model` when the tool call omits one. */
  defaultModel: string;
  /** Aliases offered as `/pi-consult` argument completions. Not enforced. */
  allowedModels: string[];
}

/** Defaults used when the config file is missing or unreadable. */
export const DEFAULTS: ConsultConfig = {
  defaultModel: "opus",
  allowedModels: ["opus", "sonnet", "haiku"],
};

/** `~/.pi/agent/pi-consult.json` — the config's canonical location. */
export function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-consult.json");
}

/** Read the config, falling back to {@link DEFAULTS} on any missing/invalid field. */
export function loadConfig(path: string = configPath()): ConsultConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConsultConfig>;
    return {
      defaultModel:
        typeof parsed.defaultModel === "string" && parsed.defaultModel.length > 0
          ? parsed.defaultModel
          : DEFAULTS.defaultModel,
      allowedModels: Array.isArray(parsed.allowedModels)
        ? parsed.allowedModels.filter((m): m is string => typeof m === "string")
        : DEFAULTS.allowedModels,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write the config, creating the parent directory if needed. */
export function saveConfig(cfg: ConsultConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
