import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { nonEmptyStr, strList } from "../../shared/fields.ts";

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
    const p = raw as Partial<ConsultConfig>;
    return {
      defaultModel: nonEmptyStr(p.defaultModel, defaults.defaultModel),
      allowedModels: strList(p.allowedModels, defaults.allowedModels),
    };
  },
};

/** `<agentDir>/pi-consult.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
