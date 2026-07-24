import { cpus } from "node:os";
import {
  configPath as sharedConfigPath,
  loadConfig as sharedLoad,
  saveConfig as sharedSave,
  type ConfigSpec,
} from "../../shared/config.ts";

export interface SpawnConfig {
  /** Model for subagents whose def doesn't pin one. "" = let pi choose its default. */
  defaultModel: string;
  /** Max subagents in flight for a parallel spawn. */
  concurrency: number;
}

export const DEFAULTS: SpawnConfig = {
  defaultModel: "",
  concurrency: Math.min(4, Math.max(1, cpus().length)),
};

export const SPEC: ConfigSpec<SpawnConfig> = {
  name: "spawn",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<SpawnConfig>;
    return {
      defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : defaults.defaultModel,
      concurrency:
        typeof p.concurrency === "number" && p.concurrency >= 1
          ? Math.floor(p.concurrency)
          : defaults.concurrency,
    };
  },
};

export function configPath(): string {
  return sharedConfigPath(SPEC.name);
}

export function loadConfig(path?: string): SpawnConfig {
  return sharedLoad(SPEC, path);
}

export function saveConfig(cfg: SpawnConfig, path?: string): void {
  sharedSave(SPEC, cfg, path);
}
