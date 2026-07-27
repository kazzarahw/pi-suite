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
  boolField("guardOpaqueWrites", "Guard shell commands", { verb: "guardshell" }),
  boolField("guardDelegated", "Guard delegated edits", { verb: "guard" }),
  intField("checkpointTtlDays", "Keep checkpoints for", { verb: "ttl", presets: [7, 30, 90] }),
  // `maxGuardedFiles` stays out of the panel deliberately (README says so): it bounds a
  // one-off tree hash and has no meaning to a user watching a rewind. `maxFileBytes` does
  // — it is the reason a file was left out of one, and the warning naming that file used
  // to point at a setting the panel did not offer.
  intField("maxFileBytes", "Max file size", { verb: "maxbytes", presets: [1_048_576, 10_485_760, 52_428_800] }),
];

/** `/pi-git` — no arg opens the settings panel; `/pi-git <off|notify|block>` sets the mode. */
export function buildGitCommand(deps: CommandDeps) {
  return defineConfigCommand("git", FIELDS, deps, {
    subtitle: "undo/redo files as you move through the session",
    bareValueField: "mode",
  });
}
