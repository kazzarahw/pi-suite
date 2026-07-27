import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { bool, int, oneOf, posNum } from "../../shared/fields.ts";
import { DEFAULT_MAX_FILE_BYTES } from "./store.ts";

/** pi-git configuration. */
export interface GitConfig {
  /** off = disabled; notify (default) = checkpoint + restore on rewind. block collapses to notify. */
  mode: Mode;
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
  /**
   * Record the repository's working set before a delegated subagent runs.
   *
   * A subagent edits from its own `pi` process, so its writes never reach this
   * extension's `tool_call` hook — the hook that captures a file's pre-edit bytes. A
   * rewind past a delegation therefore left every file the subagent touched exactly as
   * it left them, which is the one thing pi-git exists to prevent, in the case the user
   * supervised least.
   */
  guardDelegated: boolean;
  /**
   * Record the working set before a `bash` command runs.
   *
   * `bash` takes an opaque command string, so `tool_call` cannot tell which files it is
   * about to touch. Without this, a file changed only by a shell command — `sed -i`, a
   * heredoc, `git apply`, a plain `>` redirect — was first seen by the `detectDirty`
   * sweep *after* the fact, which recorded its already-modified bytes as its origin. A
   * rewind then "restored" it to the state it was being rewound *from* and reported
   * success. Shell edits were the one class of change pi-git silently could not undo.
   *
   * Costs one tracked-tree hash the first time it fires in a session; afterwards it is
   * near-free, because the store is content-addressed and origins are never rewritten.
   */
  guardOpaqueWrites: boolean;
  /**
   * Cap on files the delegation and shell guards record in one pass.
   *
   * The first guarded call in a large repository hashes and stores the whole tracked
   * tree; afterwards it is nearly free, because the store is content-addressed and an
   * origin is never rewritten once held. The cap bounds that first pass, and exceeding
   * it is *reported* rather than silently truncated — a partial guard that looks total
   * is worse than no guard.
   */
  maxGuardedFiles: number;
}

export const DEFAULTS: GitConfig = {
  mode: DEFAULT_MODE,
  checkpointTtlDays: 30,
  detectDirty: true,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  guardDelegated: true,
  guardOpaqueWrites: true,
  maxGuardedFiles: 5000,
};

export const SPEC: ConfigSpec<GitConfig> = {
  name: "git",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<GitConfig>;
    return {
      mode: oneOf<Mode>(p.mode, MODES, DEFAULT_MODE),
      checkpointTtlDays: posNum(p.checkpointTtlDays, defaults.checkpointTtlDays),
      detectDirty: bool(p.detectDirty, defaults.detectDirty),
      maxFileBytes: posNum(p.maxFileBytes, defaults.maxFileBytes),
      guardDelegated: bool(p.guardDelegated, defaults.guardDelegated),
      guardOpaqueWrites: bool(p.guardOpaqueWrites, defaults.guardOpaqueWrites),
      maxGuardedFiles: int(p.maxGuardedFiles, defaults.maxGuardedFiles),
    };
  },
};

/** `<agentDir>/pi-git.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
