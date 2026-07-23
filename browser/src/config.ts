import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BrowserConfig {
  /** Path to the agent-browser binary (default: on PATH). */
  binPath: string;
  /** Optional agent-browser session name for isolation (default: its "default" session). */
  session?: string;
}

export const DEFAULTS: BrowserConfig = { binPath: "agent-browser" };

export function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-browser.json");
}

export function loadConfig(path: string = configPath()): BrowserConfig {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<BrowserConfig>;
    return {
      binPath: typeof p.binPath === "string" && p.binPath.length > 0 ? p.binPath : DEFAULTS.binPath,
      session: typeof p.session === "string" && p.session.length > 0 ? p.session : undefined,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: BrowserConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
