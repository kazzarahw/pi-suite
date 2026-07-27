import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { bool, int, oneOf } from "../../shared/fields.ts";

export interface MemoryConfig {
  /** off = no index injection / no auto-capture; notify (default) = both. block collapses to notify. */
  mode: Mode;
  /** Capture a gotcha memory on verify:failed (off by default — naive capture is noisy). */
  autoCapture: boolean;
  /** Max memory bodies a query recall returns. */
  recallLimit: number;
  /**
   * Max entries listed in the always-injected index.
   *
   * Distinct from `recallLimit` because they bound different things: `recallLimit`
   * caps one deliberate lookup, this caps a block that rides on *every* LLM call.
   * 50 names-and-descriptions is a few hundred tokens; the overflow is still
   * reachable by `memory(action: "recall", query)`, which searches the whole store.
   */
  indexLimit: number;
}

export const DEFAULTS: MemoryConfig = {
  mode: DEFAULT_MODE,
  autoCapture: false,
  recallLimit: 3,
  indexLimit: 50,
};

export const SPEC: ConfigSpec<MemoryConfig> = {
  name: "memory",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<MemoryConfig>;
    return {
      mode: oneOf<Mode>(p.mode, MODES, DEFAULT_MODE),
      autoCapture: bool(p.autoCapture, defaults.autoCapture),
      recallLimit: int(p.recallLimit, defaults.recallLimit),
      indexLimit: int(p.indexLimit, defaults.indexLimit),
    };
  },
};

/** `<agentDir>/pi-memory.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
