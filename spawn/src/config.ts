import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, cpus } from "node:os";
import { dirname, join } from "node:path";

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

export function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-spawn.json");
}

export function loadConfig(path: string = configPath()): SpawnConfig {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<SpawnConfig>;
    return {
      defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : DEFAULTS.defaultModel,
      concurrency:
        typeof p.concurrency === "number" && p.concurrency >= 1
          ? Math.floor(p.concurrency)
          : DEFAULTS.concurrency,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: SpawnConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
