import {
  configPath as sharedConfigPath,
  loadConfig as sharedLoad,
  saveConfig as sharedSave,
  type ConfigSpec,
} from "../../shared/config.ts";
import { nonEmptyStr, optionalStr } from "../../shared/fields.ts";

export interface BrowserConfig {
  /** Path to the agent-browser binary (default: on PATH). */
  binPath: string;
  /** Optional agent-browser session name for isolation (default: its "default" session). */
  session?: string;
}

export const DEFAULTS: BrowserConfig = { binPath: "agent-browser" };

export const SPEC: ConfigSpec<BrowserConfig> = {
  name: "browser",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<BrowserConfig>;
    return {
      binPath: nonEmptyStr(p.binPath, defaults.binPath),
      session: optionalStr(p.session),
    };
  },
};

export function configPath(): string {
  return sharedConfigPath(SPEC.name);
}

export function loadConfig(path?: string): BrowserConfig {
  return sharedLoad(SPEC, path);
}

export function saveConfig(cfg: BrowserConfig, path?: string): void {
  sharedSave(SPEC, cfg, path);
}
