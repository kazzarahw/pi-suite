import type { AutocompleteItem, SettingItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openSettingsPanel } from "../../shared/settings-panel.ts";
import { MODES, type Mode } from "../../shared/index.ts";
import type { TodoConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => TodoConfig;
  saveConfig: (c: TodoConfig) => void;
}

/** `/pi-todo` — no arg opens the settings panel; `/pi-todo <off|notify|block>` sets the nudge mode directly. */
export function buildTodoCommand(deps: CommandDeps) {
  return {
    name: "pi-todo" as const,
    options: {
      description: "Configure pi-todo: '/pi-todo' opens the settings panel; or '/pi-todo <off|notify|block>'.",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = MODES.filter((m) => m.startsWith(argumentPrefix)).map((m) => ({ value: m, label: m }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const mode = args.trim();
        const cfg = deps.loadConfig();

        if (mode) {
          if (!(MODES as readonly string[]).includes(mode)) {
            ctx?.ui?.notify?.(`[pi-todo] invalid mode "${mode}" (use: ${MODES.join(", ")})`, "error");
            return;
          }
          deps.saveConfig({ ...cfg, mode: mode as Mode });
          ctx?.ui?.notify?.(`[pi-todo] mode set to: ${mode}`, "info");
          return;
        }

        if (ctx.mode !== "tui") {
          ctx?.ui?.notify?.(`[pi-todo] mode: ${cfg.mode}`, "info");
          return;
        }

        const items: SettingItem[] = [
          { id: "mode", label: "Nudge mode", currentValue: cfg.mode, values: [...MODES] },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "mode") deps.saveConfig({ ...c, mode: val as Mode });
        };
        await openSettingsPanel(ctx, "pi-todo · settings", "when to remind about open todos", items, apply);
      },
    },
  };
}
