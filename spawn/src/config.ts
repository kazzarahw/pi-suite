import { cpus } from "node:os";
import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { int, posNum, str } from "../../shared/fields.ts";

export interface SpawnConfig {
  /** Model for subagents whose def doesn't pin one. "" = let pi choose its default. */
  defaultModel: string;
  /** Max subagents in flight for a parallel spawn. */
  concurrency: number;
  /** Deadline for a single delegated job. A wedged subagent otherwise runs until noticed. */
  jobTimeoutMs: number;
}

export const DEFAULTS: SpawnConfig = {
  defaultModel: "",
  concurrency: Math.min(4, Math.max(1, cpus().length)),
  jobTimeoutMs: 900_000,
};

export const SPEC: ConfigSpec<SpawnConfig> = {
  name: "spawn",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<SpawnConfig>;
    return {
      defaultModel: str(p.defaultModel, defaults.defaultModel),
      jobTimeoutMs: posNum(p.jobTimeoutMs, defaults.jobTimeoutMs),
      concurrency: int(p.concurrency, defaults.concurrency),
    };
  },
};

/** `<agentDir>/pi-spawn.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
