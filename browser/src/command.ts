import { defineConfigCommand, stringField, type Field } from "../../shared/config-command.ts";
import type { BrowserConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => BrowserConfig;
  saveConfig: (c: BrowserConfig) => void;
}

const DEFAULT_SESSION = "(default)";

export const FIELDS: readonly Field<BrowserConfig>[] = [
  stringField("binPath", "Browser binary", { presets: ["agent-browser"] }),
  // `session` is optional: absent means agent-browser's own default session. The display
  // maps that to a visible placeholder and — critically — back to `undefined` on the way
  // in, so picking "(default)" clears the setting rather than storing the literal.
  stringField("session", "Session", {
    display: { placeholder: DEFAULT_SESSION, storedWhenPlaceholder: undefined },
  }),
];

/** `/pi-browser` — no arg opens the settings panel; `binPath <path>` / `session <name>` set fields. */
export function buildBrowserCommand(deps: CommandDeps) {
  return defineConfigCommand("browser", FIELDS, deps, {
    subtitle: "agent-browser CLI wiring",
  });
}
