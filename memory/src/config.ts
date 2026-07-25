import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import {
  configPath as sharedConfigPath,
  loadConfig as sharedLoad,
  saveConfig as sharedSave,
  type ConfigSpec,
} from "../../shared/config.ts";
import { bool, int, oneOf } from "../../shared/fields.ts";

export interface MemoryConfig {
  /** off = no index injection / no auto-capture; notify (default) = both. block collapses to notify. */
  mode: Mode;
  /** Capture a gotcha memory on verify:failed (off by default — naive capture is noisy). */
  autoCapture: boolean;
  /** Max memory bodies a query recall returns. */
  recallLimit: number;
}

export const DEFAULTS: MemoryConfig = { mode: DEFAULT_MODE, autoCapture: false, recallLimit: 3 };

export const SPEC: ConfigSpec<MemoryConfig> = {
  name: "memory",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<MemoryConfig>;
    return {
      mode: oneOf<Mode>(p.mode, MODES, DEFAULT_MODE),
      autoCapture: bool(p.autoCapture, defaults.autoCapture),
      recallLimit: int(p.recallLimit, defaults.recallLimit),
    };
  },
};

export function configPath(): string {
  return sharedConfigPath(SPEC.name);
}

export function loadConfig(path?: string): MemoryConfig {
  return sharedLoad(SPEC, path);
}

export function saveConfig(cfg: MemoryConfig, path?: string): void {
  sharedSave(SPEC, cfg, path);
}
