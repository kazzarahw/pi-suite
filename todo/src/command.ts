import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { MODES, type Mode } from "pi-shared";
import type { TodoConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => TodoConfig;
  saveConfig: (c: TodoConfig) => void;
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

/** `/pi-todo` — no arg opens the settings panel; `/pi-todo <off|notify|block>` sets the nudge mode directly. */
export function buildTodoCommand(deps: CommandDeps) {
  return {
    name: "pi-todo" as const,
    options: {
      description: "Configure pi-todo: '/pi-todo' opens the settings panel; or '/pi-todo <off|notify|block>'.",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = MODES.filter((m) => m.startsWith(argumentPrefix)).map((m) => ({ value: m, label: m }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const mode = args.trim();
        const cfg = deps.loadConfig();

        if (mode) {
          if (!(MODES as readonly string[]).includes(mode)) {
            ctx?.ui?.notify?.(`[pi-todo] invalid mode "${mode}" (use: ${MODES.join(", ")})`, "error");
            return;
          }
          deps.saveConfig({ ...cfg, mode: mode as Mode });
          ctx?.ui?.notify?.(`[pi-todo] mode set to: ${mode}`, "info");
          return;
        }

        if (ctx.mode !== "tui") {
          ctx?.ui?.notify?.(`[pi-todo] mode: ${cfg.mode}`, "info");
          return;
        }

        const items: SettingItem[] = [
          { id: "mode", label: "Nudge mode", currentValue: cfg.mode, values: [...MODES] },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "mode") deps.saveConfig({ ...c, mode: val as Mode });
        };
        await openSettingsPanel(ctx, "pi-todo · settings", "when to remind about open todos", items, apply);
      },
    },
  };
}
