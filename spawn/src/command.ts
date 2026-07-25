import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { openSettingsPanel } from "../../shared/settings-panel.ts";
import type { AgentDef } from "./agents.ts";
import type { SpawnConfig } from "./config.ts";
import { cwdOf } from "../../shared/index.ts";

export interface CommandDeps {
  loadConfig: () => SpawnConfig;
  saveConfig: (c: SpawnConfig) => void;
  /** Resolved at invoke time from the command's own context, not at extension load. */
  listAgents: (cwd: string) => AgentDef[];
}


const CONCURRENCY_PRESETS = ["1", "2", "3", "4", "6", "8"];
const MODEL_PRESETS = ["(pi default)", "opus", "sonnet", "haiku"];

/** `/pi-spawn` — no arg opens the settings panel; `model <name>` / `concurrency <n>` set fields directly. */
export function buildSpawnCommand(deps: CommandDeps) {
  return {
    name: "pi-spawn" as const,
    options: {
      description: "Configure pi-spawn: '/pi-spawn' opens the settings panel; or 'model <name>' / 'concurrency <n>'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        const cfg = deps.loadConfig();

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
        if (key) {
          ctx?.ui?.notify?.(`[pi-spawn] unknown option "${key}" (use: model <name> | concurrency <n>)`, "error");
          return;
        }

        const roster = deps.listAgents(cwdOf(ctx)).map((a) => a.name).join(", ") || "none";
        if (ctx.mode !== "tui") {
          const model = cfg.defaultModel || "(pi default)";
          ctx?.ui?.notify?.(`[pi-spawn] model: ${model} · concurrency: ${cfg.concurrency} · agents: ${roster}`, "info");
          return;
        }

        const modelDisplay = cfg.defaultModel || "(pi default)";
        const items: SettingItem[] = [
          { id: "model", label: "Subagent model", currentValue: modelDisplay, values: [...new Set([modelDisplay, ...MODEL_PRESETS])] },
          {
            id: "concurrency",
            label: "Concurrency",
            currentValue: String(cfg.concurrency),
            values: [...new Set([String(cfg.concurrency), ...CONCURRENCY_PRESETS])].sort((a, b) => Number(a) - Number(b)),
          },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "model") deps.saveConfig({ ...c, defaultModel: val === "(pi default)" ? "" : val });
          else if (id === "concurrency") {
            const n = Number(val);
            if (Number.isInteger(n) && n >= 1) deps.saveConfig({ ...c, concurrency: n });
          }
        };
        await openSettingsPanel(ctx, "pi-spawn · settings", `agents: ${roster}`, items, apply);
      },
    },
  };
}
