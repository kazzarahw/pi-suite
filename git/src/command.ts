import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODES, type Mode } from "pi-shared";
import type { GitConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => GitConfig;
  saveConfig: (c: GitConfig) => void;
}

/** `/pi-git`: no arg reports the config; `/pi-git <mode>` sets the enforcement mode. */
export function buildGitCommand(deps: CommandDeps) {
  return {
    name: "pi-git" as const,
    options: {
      description: "View pi-git config, or set its mode (off | notify | block).",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = MODES.filter((m) => m.startsWith(argumentPrefix)).map((m) => ({
          value: m,
          label: m,
        }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const arg = args.trim();
        const cfg = deps.loadConfig();
        if (!arg) {
          ctx?.ui?.notify?.(
            `[pi-git] mode: ${cfg.mode} · worktrees.auto: ${cfg.worktrees.auto} · baseDir: ${cfg.worktrees.baseDir}`,
            "info",
          );
          return;
        }
        if (!(MODES as readonly string[]).includes(arg)) {
          ctx?.ui?.notify?.(`[pi-git] invalid mode "${arg}" (use: ${MODES.join(", ")})`, "error");
          return;
        }
        deps.saveConfig({ ...cfg, mode: arg as Mode });
        ctx?.ui?.notify?.(`[pi-git] mode set to: ${arg}`, "info");
      },
    },
  };
}
