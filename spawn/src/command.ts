import { cwdOf } from "../../shared/index.ts";
import {
  defineConfigCommand,
  intField,
  stringField,
  type Field,
} from "../../shared/config-command.ts";
import type { AgentDef } from "./agents.ts";
import type { SpawnConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => SpawnConfig;
  saveConfig: (c: SpawnConfig) => void;
  /** Resolved at invoke time from the command's own context, not at extension load. */
  listAgents: (cwd: string) => AgentDef[];
}

const PI_DEFAULT = "(pi default)";

export const FIELDS: readonly Field<SpawnConfig>[] = [
  // `""` means "let pi choose", which would render as a blank row; the display maps it
  // to a label and back again so picking the label clears the setting.
  stringField("defaultModel", "Subagent model", {
    verb: "model",
    presets: ["opus", "sonnet", "haiku"],
    display: { placeholder: PI_DEFAULT },
  }),
  intField("concurrency", "Concurrency", { presets: [1, 2, 3, 4, 6, 8] }),
];

/** `/pi-spawn` — no arg opens the settings panel; `model <name>` / `concurrency <n>` set fields. */
export function buildSpawnCommand(deps: CommandDeps) {
  const roster = (ctx: Parameters<typeof cwdOf>[0]): string =>
    deps.listAgents(cwdOf(ctx)).map((a) => a.name).join(", ") || "none";

  return defineConfigCommand("spawn", FIELDS, deps, {
    // The roster is discovered from disk per invocation, so it is a function of ctx
    // rather than a constant captured when the extension loaded.
    subtitle: (ctx) => `agents: ${roster(ctx)}`,
    readoutExtra: (_cfg, ctx) => `agents: ${roster(ctx)}`,
  });
}
