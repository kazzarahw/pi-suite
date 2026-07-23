import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BrowserConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => BrowserConfig;
  saveConfig: (c: BrowserConfig) => void;
}

/** `/pi-browser` — no arg shows config; `binPath <path>` / `session <name>` set fields. */
export function buildBrowserCommand(deps: CommandDeps) {
  return {
    name: "pi-browser" as const,
    options: {
      description: "View pi-browser config, or set 'binPath <path>' / 'session <name>'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        const cfg = deps.loadConfig();

        if (!key) {
          ctx?.ui?.notify?.(`[pi-browser] binPath: ${cfg.binPath} · session: ${cfg.session ?? "(default)"}`, "info");
          return;
        }
        if (key === "binPath") {
          deps.saveConfig({ ...cfg, binPath: value || "agent-browser" });
          ctx?.ui?.notify?.(`[pi-browser] binPath set to: ${value || "agent-browser"}`, "info");
          return;
        }
        if (key === "session") {
          deps.saveConfig({ ...cfg, session: value || undefined });
          ctx?.ui?.notify?.(`[pi-browser] session set to: ${value || "(default)"}`, "info");
          return;
        }
        ctx?.ui?.notify?.(`[pi-browser] unknown option "${key}" (use: binPath <path> | session <name>)`, "error");
      },
    },
  };
}
