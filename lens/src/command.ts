import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { openSettingsPanel } from "../../shared/settings-panel.ts";
import { MODES, cwdOf, type Mode } from "../../shared/index.ts";
import type { LensConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => LensConfig;
  saveConfig: (c: LensConfig) => void;
  /** Resolved at invoke time from the command's own context, not at extension load. */
  detectVerify: (cwd: string) => string | null;
  health: () => string;
  healthCompact: () => string;
}

/** `/pi-lens` — no arg opens the settings panel; `mode <m>` / `verify <cmd>` / `autoformat on|off` set fields directly. */
export function buildLensCommand(deps: CommandDeps) {
  const verifyPresets = (cfg: LensConfig): string[] => {
    const display = cfg.verifyCmd || "(autodetect)";
    return [...new Set([display, "(autodetect)", "bun test", "npm test", "pytest"])];
  };

  return {
    name: "pi-lens" as const,
    options: {
      description: "Configure pi-lens: '/pi-lens' opens the settings panel; or 'mode <m>' / 'verify <cmd>' / 'autoformat on|off' / 'prewarm on|off'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const trimmed = args.trim();
        const sp = trimmed.indexOf(" ");
        const key = sp === -1 ? trimmed : trimmed.slice(0, sp);
        const value = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
        const cfg = deps.loadConfig();

        // Direct arg form (scripting / power users) — unchanged.
        if (key === "mode") {
          if (!(MODES as readonly string[]).includes(value)) {
            ctx?.ui?.notify?.(`[pi-lens] invalid mode "${value}" (use: ${MODES.join(", ")})`, "error");
            return;
          }
          deps.saveConfig({ ...cfg, mode: value as Mode });
          ctx?.ui?.notify?.(`[pi-lens] mode set to: ${value}`, "info");
          return;
        }
        if (key === "verify") {
          deps.saveConfig({ ...cfg, verifyCmd: value });
          ctx?.ui?.notify?.(`[pi-lens] verify command set to: ${value || "(autodetect)"}`, "info");
          return;
        }
        if (key === "autoformat") {
          const on = value === "on" || value === "true";
          deps.saveConfig({ ...cfg, autoFormat: on });
          ctx?.ui?.notify?.(`[pi-lens] autoFormat ${on ? "on" : "off"}`, "info");
          return;
        }
        if (key === "prewarm") {
          const on = value === "on" || value === "true";
          deps.saveConfig({ ...cfg, prewarm: on });
          ctx?.ui?.notify?.(`[pi-lens] prewarm ${on ? "on" : "off"}`, "info");
          return;
        }
        if (key) {
          ctx?.ui?.notify?.(
            `[pi-lens] unknown option "${key}" (use: mode <m> | verify <cmd> | autoformat on|off | prewarm on|off)`,
            "error",
          );
          return;
        }

        // No args: interactive settings panel (TUI), else a text readout.
        if (ctx.mode !== "tui") {
          const verify = cfg.verifyCmd || `${deps.detectVerify(cwdOf(ctx)) ?? "(none)"} (auto)`;
          ctx?.ui?.notify?.(`[pi-lens] mode: ${cfg.mode} · autoFormat: ${cfg.autoFormat ? "on" : "off"} · verify: ${verify}`, "info");
          ctx?.ui?.notify?.(`[pi-lens] ${deps.health()}`, "info");
          return;
        }

        const items: SettingItem[] = [
          { id: "mode", label: "Mode", currentValue: cfg.mode, values: [...MODES] },
          { id: "autoformat", label: "Auto-format", currentValue: cfg.autoFormat ? "on" : "off", values: ["on", "off"] },
          { id: "prewarm", label: "Prewarm LSP", currentValue: cfg.prewarm ? "on" : "off", values: ["on", "off"] },
          { id: "verify", label: "Verify", currentValue: cfg.verifyCmd || "(autodetect)", values: verifyPresets(cfg) },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "mode") deps.saveConfig({ ...c, mode: val as Mode });
          else if (id === "autoformat") deps.saveConfig({ ...c, autoFormat: val === "on" });
          else if (id === "prewarm") deps.saveConfig({ ...c, prewarm: val === "on" });
          else if (id === "verify") deps.saveConfig({ ...c, verifyCmd: val === "(autodetect)" ? "" : val });
        };
        await openSettingsPanel(ctx, "pi-lens · settings", deps.healthCompact(), items, apply);
      },
    },
  };
}
