import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { ConsultConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => ConsultConfig;
  saveConfig: (c: ConsultConfig) => void;
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

/** `/pi-consult` — no arg opens the settings panel; `/pi-consult <model>` sets the default model directly. */
export function buildConsultCommand(deps: CommandDeps) {
  return {
    name: "pi-consult" as const,
    options: {
      description: "Configure pi-consult: '/pi-consult' opens the settings panel; or '/pi-consult <model>'.",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = deps
          .loadConfig()
          .allowedModels.filter((m) => m.startsWith(argumentPrefix))
          .map((m) => ({ value: m, label: m }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const model = args.trim();
        const cfg = deps.loadConfig();

        if (model) {
          deps.saveConfig({ ...cfg, defaultModel: model });
          ctx?.ui?.notify?.(`[pi-consult] default model set to: ${model}`, "info");
          return;
        }

        if (ctx.mode !== "tui") {
          ctx?.ui?.notify?.(`[pi-consult] default model: ${cfg.defaultModel}`, "info");
          return;
        }

        const values = [...new Set([cfg.defaultModel, ...cfg.allowedModels])];
        const items: SettingItem[] = [
          { id: "model", label: "Default model", currentValue: cfg.defaultModel, values },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "model") deps.saveConfig({ ...c, defaultModel: val });
        };
        await openSettingsPanel(ctx, "pi-consult · settings", "second-opinion model for the consult tool", items, apply);
      },
    },
  };
}
