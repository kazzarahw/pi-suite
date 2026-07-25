import { MODES } from "../../shared/index.ts";
import {
  boolField,
  defineConfigCommand,
  enumField,
  intField,
  type Field,
} from "../../shared/config-command.ts";
import type { GitConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => GitConfig;
  saveConfig: (c: GitConfig) => void;
}

export const FIELDS: readonly Field<GitConfig>[] = [
  enumField("mode", MODES, "Mode"),
  boolField("detectDirty", "Detect bash changes", { verb: "detect" }),
  intField("checkpointTtlDays", "Keep checkpoints for", { verb: "ttl", presets: [7, 30, 90] }),
];

/** `/pi-git` — no arg opens the settings panel; `/pi-git <off|notify|block>` sets the mode. */
export function buildGitCommand(deps: CommandDeps) {
  return defineConfigCommand("git", FIELDS, deps, {
    subtitle: "undo/redo files as you move through the session",
    bareValueField: "mode",
  });
}
