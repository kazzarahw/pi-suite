import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { BrowserConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => BrowserConfig;
  saveConfig: (c: BrowserConfig) => void;
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
