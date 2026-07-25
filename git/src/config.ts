import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import {
  configPath as sharedConfigPath,
  loadConfig as sharedLoad,
  saveConfig as sharedSave,
  type ConfigSpec,
} from "../../shared/config.ts";
import { DEFAULT_MAX_FILE_BYTES } from "./store.ts";

/** pi-git configuration. */
export interface GitConfig {
  /** off = disabled; notify (default) = checkpoint + restore on rewind. block collapses to notify. */
  mode: Mode;
  worktrees: {
    /** Whether pi-spawn parallel jobs get an isolated worktree by default. */
    auto: boolean;
    /** Where worktrees are created (relative to cwd or absolute). */
    baseDir: string;
  };
  /**
   * How long a session's checkpoints survive. Age-based rather than a count cap:
   * navigation can reach arbitrarily far back, so pruning all but the newest N
   * would silently break a restore that is still reachable.
   */
  checkpointTtlDays: number;
  /**
   * Also checkpoint whatever git reports as changed, not only the files that passed
   * through the write/edit tools. This is what covers a file `bash` created or edited.
   */
  detectDirty: boolean;
  /** Files larger than this are reported and left out rather than stored. */
  maxFileBytes: number;
}

export const DEFAULTS: GitConfig = {
  mode: DEFAULT_MODE,
  worktrees: { auto: false, baseDir: ".pi/worktrees" },
  checkpointTtlDays: 30,
  detectDirty: true,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
};

/** A finite, positive number, or the default. Guards against `0`, `-1`, and `NaN` from a hand-edited file. */
const positive = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

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
      checkpointTtlDays: positive(p.checkpointTtlDays, defaults.checkpointTtlDays),
      detectDirty: typeof p.detectDirty === "boolean" ? p.detectDirty : defaults.detectDirty,
      maxFileBytes: positive(p.maxFileBytes, defaults.maxFileBytes),
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
