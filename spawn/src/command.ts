import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "./agents.ts";
import type { SpawnConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => SpawnConfig;
  saveConfig: (c: SpawnConfig) => void;
  listAgents: () => AgentDef[];
}

/**
 * `/pi-spawn` — no arg shows config + roster; `model <name>` and `concurrency <n>` set fields.
 */
export function buildSpawnCommand(deps: CommandDeps) {
  return {
    name: "pi-spawn" as const,
    options: {
      description: "View pi-spawn config + roster, or set 'model <name>' / 'concurrency <n>'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        const cfg = deps.loadConfig();

        if (!key) {
          const roster = deps.listAgents().map((a) => a.name).join(", ") || "none";
          const model = cfg.defaultModel || "(pi default)";
          ctx?.ui?.notify?.(
            `[pi-spawn] model: ${model} · concurrency: ${cfg.concurrency} · agents: ${roster}`,
            "info",
          );
          return;
        }
        if (key === "model") {
          deps.saveConfig({ ...cfg, defaultModel: value });
          ctx?.ui?.notify?.(`[pi-spawn] default model set to: ${value || "(pi default)"}`, "info");
          return;
        }
        if (key === "concurrency") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) {
            ctx?.ui?.notify?.(`[pi-spawn] concurrency must be a positive integer`, "error");
            return;
          }
          deps.saveConfig({ ...cfg, concurrency: n });
          ctx?.ui?.notify?.(`[pi-spawn] concurrency set to: ${n}`, "info");
          return;
        }
        ctx?.ui?.notify?.(`[pi-spawn] unknown option "${key}" (use: model <name> | concurrency <n>)`, "error");
      },
    },
  };
}
