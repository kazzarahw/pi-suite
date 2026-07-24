import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { MODES, type Mode } from "pi-shared";
import type { MemoryConfig } from "./config.ts";
import type { Memory } from "./frontmatter.ts";

export interface CommandDeps {
  loadConfig: () => MemoryConfig;
  saveConfig: (c: MemoryConfig) => void;
  listMemories: () => Memory[];
  deleteMemory: (name: string) => void;
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

const RECALL_PRESETS = ["1", "2", "3", "5", "10"];

/** `/pi-memory` — no arg opens the settings panel; `mode <m>` / `autocapture on|off` / `delete <name>` act directly. */
export function buildMemoryCommand(deps: CommandDeps) {
  return {
    name: "pi-memory" as const,
    options: {
      description: "Configure pi-memory: '/pi-memory' opens the settings panel; or 'mode <m>' / 'autocapture on|off' / 'delete <name>'.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        const cfg = deps.loadConfig();

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
        if (key) {
          ctx?.ui?.notify?.(
            `[pi-memory] unknown option "${key}" (use: mode <m> | autocapture on|off | delete <name>)`,
            "error",
          );
          return;
        }

        const count = deps.listMemories().length;
        if (ctx.mode !== "tui") {
          const names = deps.listMemories().map((m) => m.name).join(", ") || "none";
          ctx?.ui?.notify?.(`[pi-memory] mode: ${cfg.mode} · autoCapture: ${cfg.autoCapture} · memories: ${names}`, "info");
          return;
        }

        const items: SettingItem[] = [
          { id: "mode", label: "Mode", currentValue: cfg.mode, values: [...MODES] },
          { id: "autocapture", label: "Auto-capture on verify-fail", currentValue: cfg.autoCapture ? "on" : "off", values: ["on", "off"] },
          {
            id: "recalllimit",
            label: "Recall limit",
            currentValue: String(cfg.recallLimit),
            values: [...new Set([String(cfg.recallLimit), ...RECALL_PRESETS])].sort((a, b) => Number(a) - Number(b)),
          },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "mode") deps.saveConfig({ ...c, mode: val as Mode });
          else if (id === "autocapture") deps.saveConfig({ ...c, autoCapture: val === "on" });
          else if (id === "recalllimit") {
            const n = Number(val);
            if (Number.isInteger(n) && n >= 1) deps.saveConfig({ ...c, recallLimit: n });
          }
        };
        await openSettingsPanel(ctx, "pi-memory · settings", `${count} memory(ies) stored · delete via 'delete <name>'`, items, apply);
      },
    },
  };
}
