import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import {
  configPath as sharedConfigPath,
  loadConfig as sharedLoad,
  saveConfig as sharedSave,
  type ConfigSpec,
} from "../../shared/config.ts";

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

export const SPEC: ConfigSpec<GitConfig> = {
  name: "git",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<GitConfig>;
    return {
      mode: (MODES as readonly string[]).includes(p.mode as string) ? (p.mode as Mode) : DEFAULT_MODE,
      worktrees: {
        auto: typeof p.worktrees?.auto === "boolean" ? p.worktrees.auto : defaults.worktrees.auto,
        baseDir:
          typeof p.worktrees?.baseDir === "string" ? p.worktrees.baseDir : defaults.worktrees.baseDir,
      },
    };
  },
};

export function configPath(): string {
  return sharedConfigPath(SPEC.name);
}

export function loadConfig(path?: string): GitConfig {
  return sharedLoad(SPEC, path);
}

export function saveConfig(cfg: GitConfig, path?: string): void {
  sharedSave(SPEC, cfg, path);
}
