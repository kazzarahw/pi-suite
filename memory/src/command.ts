import { MODES, cwdOf } from "../../shared/index.ts";
import {
  boolField,
  defineConfigCommand,
  enumField,
  intField,
  type ExtraVerb,
  type Field,
} from "../../shared/config-command.ts";
import type { MemoryConfig } from "./config.ts";
import type { Memory } from "./frontmatter.ts";

export interface CommandDeps {
  loadConfig: () => MemoryConfig;
  saveConfig: (c: MemoryConfig) => void;
  /** Resolved at invoke time from the command's own context, not at extension load. */
  listMemories: (cwd: string) => readonly Memory[];
  deleteMemory: (name: string, cwd: string) => void;
}

export const FIELDS: readonly Field<MemoryConfig>[] = [
  enumField("mode", MODES, "Mode"),
  boolField("autoCapture", "Auto-capture on verify-fail", { verb: "autocapture" }),
  intField("recallLimit", "Recall limit", { verb: "recalllimit", presets: [1, 2, 3, 5, 10] }),
  intField("indexLimit", "Index limit (injected every call)", {
    verb: "indexlimit",
    presets: [10, 25, 50, 100, 250],
  }),
];

/** `/pi-memory` — no arg opens the settings panel; `mode` / `autocapture` / `delete <name>`. */
export function buildMemoryCommand(deps: CommandDeps) {
  // Deleting a memory is an action on stored data, not a setting. It stays a verb rather
  // than being forced into the field table, where it has no value to display or cycle.
  const del: ExtraVerb = {
    verb: "delete",
    usage: "delete <name>",
    handle: (value, ctx, notify) => {
      if (!value) {
        notify.error("usage: delete <name>");
        return;
      }
      deps.deleteMemory(value, cwdOf(ctx));
      notify.info(`deleted "${value}"`);
    },
  };

  const count = (ctx: Parameters<typeof cwdOf>[0]): number => deps.listMemories(cwdOf(ctx)).length;

  return defineConfigCommand("memory", FIELDS, deps, {
    extraVerbs: [del],
    subtitle: (ctx) => `${count(ctx)} memory(ies) stored · delete via 'delete <name>'`,
    readoutExtra: (_cfg, ctx) =>
      `memories: ${deps.listMemories(cwdOf(ctx)).map((m) => m.name).join(", ") || "none"}`,
  });
}
