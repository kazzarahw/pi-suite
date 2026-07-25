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

/**
 * `/pi-browser` — opens the settings panel.
 *
 * The verbs are `binpath` / `session`, lowercased from the config keys like every other
 * command in the suite. The old handler matched `binPath` with its camelCase intact, so
 * that spelling is gone; the panel is the intended way to set these.
 */
export function buildBrowserCommand(deps: CommandDeps) {
  return defineConfigCommand("browser", FIELDS, deps, {
    subtitle: "agent-browser CLI wiring",
  });
}
