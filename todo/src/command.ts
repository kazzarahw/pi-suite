import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODES, type Mode } from "pi-shared";
import type { TodoConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => TodoConfig;
  saveConfig: (c: TodoConfig) => void;
}

/** Build the `/pi-todo` command: no arg reports the mode, `/pi-todo <mode>` sets it. */
export function buildTodoCommand(deps: CommandDeps) {
  return {
    name: "pi-todo" as const,
    options: {
      description: "View or set pi-todo's nudge mode (off | notify | block).",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = MODES.filter((m) => m.startsWith(argumentPrefix)).map((m) => ({
          value: m,
          label: m,
        }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const mode = args.trim();
        const cfg = deps.loadConfig();
        if (!mode) {
          ctx?.ui?.notify?.(`[pi-todo] mode: ${cfg.mode}`, "info");
          return;
        }
        if (!(MODES as readonly string[]).includes(mode)) {
          ctx?.ui?.notify?.(`[pi-todo] invalid mode "${mode}" (use: ${MODES.join(", ")})`, "error");
          return;
        }
        deps.saveConfig({ ...cfg, mode: mode as Mode });
        ctx?.ui?.notify?.(`[pi-todo] mode set to: ${mode}`, "info");
      },
    },
  };
}
