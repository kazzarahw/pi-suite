import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { AgentDef } from "./agents.ts";
import type { SpawnConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => SpawnConfig;
  saveConfig: (c: SpawnConfig) => void;
  listAgents: () => AgentDef[];
}

/**
 * Open a `/settings`-style toggle panel: an arrow-navigable list of `items`, each cycling through its
 * `values`. `apply(id, value)` persists a single change (fires on every toggle). Requires TUI mode.
 */
async function openSettingsPanel(
  ctx: ExtensionCommandContext,
  title: string,
  subtitle: string,
  items: SettingItem[],
  apply: (id: string, value: string) => void,
): Promise<void> {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new (class {
        render(width: number): string[] {
          const clip = (s: string): string => (s.length > width ? s.slice(0, Math.max(0, width - 1)) : s);
          return [theme.fg("accent", theme.bold(clip(title))), theme.fg("muted", clip(subtitle)), ""];
        }
        invalidate(): void {}
      })(),
    );
    const list = new SettingsList(
      items,
      Math.min(items.length + 4, 15),
      getSettingsListTheme(),
      (id, value) => apply(id, value),
      () => done(undefined),
    );
    container.addChild(list);
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
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

        const roster = deps.listAgents().map((a) => a.name).join(", ") || "none";
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
