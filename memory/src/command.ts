import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODES, type Mode } from "pi-shared";
import type { MemoryConfig } from "./config.ts";
import type { Memory } from "./frontmatter.ts";

export interface CommandDeps {
  loadConfig: () => MemoryConfig;
  saveConfig: (c: MemoryConfig) => void;
  listMemories: () => Memory[];
  deleteMemory: (name: string) => void;
}

/** `/pi-memory` — no arg lists memories + config; `mode <m>` / `autocapture on|off` / `delete <name>`. */
export function buildMemoryCommand(deps: CommandDeps) {
  return {
    name: "pi-memory" as const,
    options: {
      description: "List memories + config, or set 'mode <m>' / 'autocapture on|off' / 'delete <name>'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        const cfg = deps.loadConfig();

        if (!key) {
          const names = deps.listMemories().map((m) => m.name).join(", ") || "none";
          ctx?.ui?.notify?.(
            `[pi-memory] mode: ${cfg.mode} · autoCapture: ${cfg.autoCapture} · memories: ${names}`,
            "info",
          );
          return;
        }
        if (key === "mode") {
          if (!(MODES as readonly string[]).includes(value)) {
            ctx?.ui?.notify?.(`[pi-memory] invalid mode "${value}" (use: ${MODES.join(", ")})`, "error");
            return;
          }
          deps.saveConfig({ ...cfg, mode: value as Mode });
          ctx?.ui?.notify?.(`[pi-memory] mode set to: ${value}`, "info");
          return;
        }
        if (key === "autocapture") {
          const on = value === "on" || value === "true";
          deps.saveConfig({ ...cfg, autoCapture: on });
          ctx?.ui?.notify?.(`[pi-memory] autoCapture ${on ? "on" : "off"}`, "info");
          return;
        }
        if (key === "delete") {
          if (!value) {
            ctx?.ui?.notify?.(`[pi-memory] usage: delete <name>`, "error");
            return;
          }
          deps.deleteMemory(value);
          ctx?.ui?.notify?.(`[pi-memory] deleted "${value}"`, "info");
          return;
        }
        ctx?.ui?.notify?.(
          `[pi-memory] unknown option "${key}" (use: mode <m> | autocapture on|off | delete <name>)`,
          "error",
        );
      },
    },
  };
}
