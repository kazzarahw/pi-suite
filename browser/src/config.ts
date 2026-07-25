import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
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

/** `<agentDir>/pi-browser.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
