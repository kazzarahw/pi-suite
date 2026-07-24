import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { openSettingsPanel } from "../../shared/settings-panel.ts";
import type { BrowserConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => BrowserConfig;
  saveConfig: (c: BrowserConfig) => void;
}


const DEFAULT_SESSION = "(default)";

/** `/pi-browser` — no arg opens the settings panel; `binPath <path>` / `session <name>` set fields directly. */
export function buildBrowserCommand(deps: CommandDeps) {
  return {
    name: "pi-browser" as const,
    options: {
      description: "Configure pi-browser: '/pi-browser' opens the settings panel; or 'binPath <path>' / 'session <name>'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        const cfg = deps.loadConfig();

        if (key === "binPath") {
          deps.saveConfig({ ...cfg, binPath: value || "agent-browser" });
          ctx?.ui?.notify?.(`[pi-browser] binPath set to: ${value || "agent-browser"}`, "info");
          return;
        }
        if (key === "session") {
          deps.saveConfig({ ...cfg, session: value || undefined });
          ctx?.ui?.notify?.(`[pi-browser] session set to: ${value || DEFAULT_SESSION}`, "info");
          return;
        }
        if (key) {
          ctx?.ui?.notify?.(`[pi-browser] unknown option "${key}" (use: binPath <path> | session <name>)`, "error");
          return;
        }

        if (ctx.mode !== "tui") {
          ctx?.ui?.notify?.(`[pi-browser] binPath: ${cfg.binPath} · session: ${cfg.session ?? DEFAULT_SESSION}`, "info");
          return;
        }

        const sessionDisplay = cfg.session ?? DEFAULT_SESSION;
        const items: SettingItem[] = [
          { id: "binpath", label: "Browser binary", currentValue: cfg.binPath, values: [...new Set([cfg.binPath, "agent-browser"])] },
          { id: "session", label: "Session", currentValue: sessionDisplay, values: [...new Set([sessionDisplay, DEFAULT_SESSION])] },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "binpath") deps.saveConfig({ ...c, binPath: val || "agent-browser" });
          else if (id === "session") deps.saveConfig({ ...c, session: val === DEFAULT_SESSION ? undefined : val });
        };
        await openSettingsPanel(ctx, "pi-browser · settings", "agent-browser CLI wiring (edit paths via 'binPath <path>')", items, apply);
      },
    },
  };
}
