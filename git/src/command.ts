import type { AutocompleteItem, SettingItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openSettingsPanel } from "../../shared/settings-panel.ts";
import { MODES, type Mode } from "../../shared/index.ts";
import type { GitConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => GitConfig;
  saveConfig: (c: GitConfig) => void;
}

/** `/pi-git` — no arg opens the settings panel; `/pi-git <off|notify|block>` sets the mode directly. */
export function buildGitCommand(deps: CommandDeps) {
  return {
    name: "pi-git" as const,
    options: {
      description: "Configure pi-git: '/pi-git' opens the settings panel; or '/pi-git <off|notify|block>'.",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = MODES.filter((m) => m.startsWith(argumentPrefix)).map((m) => ({ value: m, label: m }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const arg = args.trim();
        const cfg = deps.loadConfig();

        if (arg) {
          if (!(MODES as readonly string[]).includes(arg)) {
            ctx?.ui?.notify?.(`[pi-git] invalid mode "${arg}" (use: ${MODES.join(", ")})`, "error");
            return;
          }
          deps.saveConfig({ ...cfg, mode: arg as Mode });
          ctx?.ui?.notify?.(`[pi-git] mode set to: ${arg}`, "info");
          return;
        }

        if (ctx.mode !== "tui") {
          ctx?.ui?.notify?.(
            `[pi-git] mode: ${cfg.mode} · detect bash changes: ${cfg.detectDirty} · keep checkpoints: ${cfg.checkpointTtlDays}d`,
            "info",
          );
          return;
        }

        const items: SettingItem[] = [
          { id: "mode", label: "Mode", currentValue: cfg.mode, values: [...MODES] },
          {
            id: "detect",
            label: "Detect bash changes",
            currentValue: cfg.detectDirty ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "ttl",
            label: "Keep checkpoints for",
            currentValue: String(cfg.checkpointTtlDays),
            values: [...new Set([String(cfg.checkpointTtlDays), "7", "30", "90"])],
          },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "mode") deps.saveConfig({ ...c, mode: val as Mode });
          else if (id === "detect") deps.saveConfig({ ...c, detectDirty: val === "on" });
          else if (id === "ttl") deps.saveConfig({ ...c, checkpointTtlDays: Number(val) || c.checkpointTtlDays });
        };
        await openSettingsPanel(ctx, "pi-git · settings", "undo/redo files as you move through the session", items, apply);
      },
    },
  };
}
