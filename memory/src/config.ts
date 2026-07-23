import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODE, MODES, type Mode } from "pi-shared";

export interface MemoryConfig {
  /** off = no index injection / no auto-capture; notify (default) = both. block collapses to notify. */
  mode: Mode;
  /** Capture a gotcha memory on verify:failed (off by default — naive capture is noisy). */
  autoCapture: boolean;
  /** Max memory bodies a query recall returns. */
  recallLimit: number;
}

export const DEFAULTS: MemoryConfig = { mode: DEFAULT_MODE, autoCapture: false, recallLimit: 3 };

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

export function configPath(): string {
  return join(agentDir(), "pi-memory.json");
}

export function loadConfig(path: string = configPath()): MemoryConfig {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<MemoryConfig>;
    return {
      mode: (MODES as readonly string[]).includes(p.mode as string) ? (p.mode as Mode) : DEFAULT_MODE,
      autoCapture: typeof p.autoCapture === "boolean" ? p.autoCapture : DEFAULTS.autoCapture,
      recallLimit:
        typeof p.recallLimit === "number" && p.recallLimit >= 1 ? Math.floor(p.recallLimit) : DEFAULTS.recallLimit,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: MemoryConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
