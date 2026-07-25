import { defineConfigCommand, stringField, type Field } from "../../shared/config-command.ts";
import type { ConsultConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => ConsultConfig;
  saveConfig: (c: ConsultConfig) => void;
}

/**
 * `allowedModels` is not a field here: it is the *source* of this field's presets, not
 * something the panel edits. It stays in the config file for a user to extend by hand —
 * which is why the presets are a thunk. Capturing them once would mean a model added to
 * the file mid-session never appeared in completions.
 */
export const fieldsFor = (deps: CommandDeps): readonly Field<ConsultConfig>[] => [
  stringField("defaultModel", "Default model", {
    verb: "model",
    presets: () => deps.loadConfig().allowedModels,
  }),
];

/** `/pi-consult` — no arg opens the settings panel; `/pi-consult <model>` sets the default model. */
export function buildConsultCommand(deps: CommandDeps) {
  return defineConfigCommand("consult", fieldsFor(deps), deps, {
    subtitle: "second-opinion model for the consult tool",
    bareValueField: "defaultModel",
  });
}
