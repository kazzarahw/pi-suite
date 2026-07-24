import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODE, MODES, type Mode } from "pi-shared";

export interface LensConfig {
  /** off = manual `lens` tool only; notify (default) = inject diagnostics + auto-verify; block = notify in v1 (hard gating deferred). */
  mode: Mode;
  /** Test/build command; "" = autodetect (see autodetectVerify). */
  verifyCmd: string;
  /** Auto-format a file after write/edit (default off). Runs the language's formatter in place. */
  autoFormat: boolean;
  /** Warm the language servers on session start so the first read/query is fast (default on). */
  prewarm: boolean;
}

export const DEFAULTS: LensConfig = { mode: DEFAULT_MODE, verifyCmd: "", autoFormat: false, prewarm: true };

export function configPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-lens.json");
}

export function loadConfig(path: string = configPath()): LensConfig {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<LensConfig>;
    return {
      mode: (MODES as readonly string[]).includes(p.mode as string) ? (p.mode as Mode) : DEFAULT_MODE,
      verifyCmd: typeof p.verifyCmd === "string" ? p.verifyCmd : DEFAULTS.verifyCmd,
      autoFormat: typeof p.autoFormat === "boolean" ? p.autoFormat : DEFAULTS.autoFormat,
      prewarm: typeof p.prewarm === "boolean" ? p.prewarm : DEFAULTS.prewarm,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: LensConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/** Best-effort verify command for a project, or null. Pure-ish (reads the fs). */
export function autodetectVerify(cwd: string): string | null {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun test";
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: { test?: string } };
    if (pkg.scripts?.test) return "npm test";
  } catch {
    /* no package.json */
  }
  if (
    existsSync(join(cwd, "pytest.ini")) ||
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "setup.cfg"))
  ) {
    return "pytest";
  }
  return null;
}
