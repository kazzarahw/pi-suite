import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODE, MODES, type Mode } from "pi-shared";

/** pi-git configuration. `checkpoint.include` is always "all" in v1 (kept for forward-compat). */
export interface GitConfig {
  /** off = disabled; notify (default) = checkpoint + restore-on-rewind. block collapses to notify. */
  mode: Mode;
  worktrees: {
    /** Whether pi-spawn parallel jobs get an isolated worktree by default. */
    auto: boolean;
    /** Where worktrees are created (relative to cwd or absolute). */
    baseDir: string;
  };
}

export const DEFAULTS: GitConfig = {
  mode: DEFAULT_MODE,
  worktrees: { auto: false, baseDir: ".pi/worktrees" },
};

export function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-git.json");
}

export function loadConfig(path: string = configPath()): GitConfig {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<GitConfig>;
    return {
      mode: (MODES as readonly string[]).includes(p.mode as string) ? (p.mode as Mode) : DEFAULT_MODE,
      worktrees: {
        auto: typeof p.worktrees?.auto === "boolean" ? p.worktrees.auto : DEFAULTS.worktrees.auto,
        baseDir:
          typeof p.worktrees?.baseDir === "string" ? p.worktrees.baseDir : DEFAULTS.worktrees.baseDir,
      },
    };
  } catch {
    return { mode: DEFAULTS.mode, worktrees: { ...DEFAULTS.worktrees } };
  }
}

export function saveConfig(cfg: GitConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
