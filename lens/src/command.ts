import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODES, type Mode } from "pi-shared";
import type { LensConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => LensConfig;
  saveConfig: (c: LensConfig) => void;
  detectVerify: () => string | null;
  health: () => string;
}

/** `/pi-lens` — no arg shows config + tool health; `mode <m>` / `verify <cmd>` / `autoformat on|off` set fields. */
export function buildLensCommand(deps: CommandDeps) {
  return {
    name: "pi-lens" as const,
    options: {
      description: "View pi-lens config + tool health, or set 'mode <m>' / 'verify <cmd>' / 'autoformat on|off'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const trimmed = args.trim();
        const sp = trimmed.indexOf(" ");
        const key = sp === -1 ? trimmed : trimmed.slice(0, sp);
        const value = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
        const cfg = deps.loadConfig();

        if (!key) {
          const verify = cfg.verifyCmd || `${deps.detectVerify() ?? "(none)"} (auto)`;
          ctx?.ui?.notify?.(
            `[pi-lens] mode: ${cfg.mode} · autoFormat: ${cfg.autoFormat ? "on" : "off"} · verify: ${verify}`,
            "info",
          );
          ctx?.ui?.notify?.(`[pi-lens] ${deps.health()}`, "info");
          return;
        }
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
        ctx?.ui?.notify?.(
          `[pi-lens] unknown option "${key}" (use: mode <m> | verify <cmd> | autoformat on|off)`,
          "error",
        );
      },
    },
  };
}
