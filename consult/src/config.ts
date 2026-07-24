import {
  configPath as sharedConfigPath,
  loadConfig as sharedLoad,
  saveConfig as sharedSave,
  type ConfigSpec,
} from "../../shared/config.ts";

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

export const SPEC: ConfigSpec<ConsultConfig> = {
  name: "consult",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const parsed = raw as Partial<ConsultConfig>;
    return {
      defaultModel:
        typeof parsed.defaultModel === "string" && parsed.defaultModel.length > 0
          ? parsed.defaultModel
          : defaults.defaultModel,
      allowedModels: Array.isArray(parsed.allowedModels)
        ? parsed.allowedModels.filter((m): m is string => typeof m === "string")
        : defaults.allowedModels,
    };
  },
};

/** `<agentDir>/pi-consult.json` — the config's canonical location. */
export function configPath(): string {
  return sharedConfigPath(SPEC.name);
}

/** Read the config, falling back to {@link DEFAULTS} on any missing/invalid field. */
export function loadConfig(path?: string): ConsultConfig {
  return sharedLoad(SPEC, path);
}

/** Write the config, creating the parent directory if needed. */
export function saveConfig(cfg: ConsultConfig, path?: string): void {
  sharedSave(SPEC, cfg, path);
}
