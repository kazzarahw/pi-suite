import { MODES, cwdOf } from "../../shared/index.ts";
import {
  boolField,
  defineConfigCommand,
  enumField,
  stringField,
  type Field,
} from "../../shared/config-command.ts";
import type { LensConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => LensConfig;
  saveConfig: (c: LensConfig) => void;
  /** Resolved at invoke time from the command's own context, not at extension load. */
  detectVerify: (cwd: string) => string | null;
  health: () => string;
  healthCompact: () => string;
}

const AUTODETECT = "(autodetect)";

export const FIELDS: readonly Field<LensConfig>[] = [
  enumField("mode", MODES, "Mode"),
  boolField("autoFormat", "Auto-format", { verb: "autoformat" }),
  boolField("prewarm", "Prewarm LSP"),
  // `""` means autodetect from the project. The display shows that as a label and maps
  // it back to `""`, so selecting it re-enables detection rather than storing the label
  // as a shell command.
  stringField("verifyCmd", "Verify", {
    verb: "verify",
    presets: ["bun test", "npm test", "pytest"],
    display: { placeholder: AUTODETECT },
  }),
];

/** `/pi-lens` — no arg opens the settings panel; `mode` / `verify` / `autoformat` / `prewarm`. */
export function buildLensCommand(deps: CommandDeps) {
  return defineConfigCommand("lens", FIELDS, deps, {
    // Which tools are installed is a live probe of PATH, not a setting — it belongs in
    // the subtitle and the readout, never in the field table.
    subtitle: () => deps.healthCompact(),
    readoutExtra: (cfg, ctx) => {
      const detected = cfg.verifyCmd ? "" : ` · would run: ${deps.detectVerify(cwdOf(ctx)) ?? "(none)"}`;
      return `${deps.health()}${detected}`;
    },
  });
}
