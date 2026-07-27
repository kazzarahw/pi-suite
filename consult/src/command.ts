import { defineConfigCommand, stringField, type Field } from "../../shared/config-command.ts";
import type { ConsultConfig } from "./config.ts";
import { CLAUDE_BIN } from "./consult.ts";

export interface CommandDeps {
  loadConfig: () => ConsultConfig;
  saveConfig: (c: ConsultConfig) => void;
  /** `PATH` probe, so the panel can say whether the CLI it drives is even installed. */
  which: (bin: string) => boolean;
}

/**
 * The panel's subtitle: what is wrong right now, or what it is for. Pure.
 *
 * pi-lens shows a live health line and pi-spawn its agent roster; pi-consult showed a
 * fixed sentence, so a config holding `defaultModel: "some-new-model"` — a value the
 * settings panel itself will happily store, since any string is a legal model name —
 * rendered as though nothing were wrong, and every `consult` call failed until someone
 * thought to look. The panel is where a user goes to find out; it should tell them.
 */
export function subtitleFor(cfg: ConsultConfig, which: (bin: string) => boolean): string {
  if (!which(CLAUDE_BIN)) return `\`${CLAUDE_BIN}\` is not on PATH — the consult tool cannot run`;
  // Advisory, not a verdict: allowedModels is a preset list, not an allowlist, so an
  // unlisted name may still be perfectly valid. Saying "unrecognised" rather than
  // "invalid" is the difference between a hint and a wrong claim.
  if (cfg.allowedModels.length > 0 && !cfg.allowedModels.includes(cfg.defaultModel)) {
    return `default "${cfg.defaultModel}" is not one of: ${cfg.allowedModels.join(", ")}`;
  }
  return "second-opinion model for the consult tool";
}

/**
 * `allowedModels` is not a field here: it is the *source* of this field's presets, not
 * something the panel edits. It stays in the config file for a user to extend by hand —
 * which is why the presets are a thunk. Capturing them once would mean a model added to
 * the file mid-session never appeared in completions.
 */
export const fieldsFor = (deps: Pick<CommandDeps, "loadConfig">): readonly Field<ConsultConfig>[] => [
  stringField("defaultModel", "Default model", {
    verb: "model",
    presets: () => deps.loadConfig().allowedModels,
  }),
];

/** `/pi-consult` — no arg opens the settings panel; `/pi-consult <model>` sets the default model. */
export function buildConsultCommand(deps: CommandDeps) {
  return defineConfigCommand("consult", fieldsFor(deps), deps, {
    // A thunk, because both halves are live: the config is re-read per call, and whether
    // `claude` is installed can change under a running session.
    subtitle: () => subtitleFor(deps.loadConfig(), deps.which),
    bareValueField: "defaultModel",
  });
}
