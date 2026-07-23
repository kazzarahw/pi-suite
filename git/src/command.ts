import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { MODES, type Mode } from "pi-shared";
import type { GitConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => GitConfig;
  saveConfig: (c: GitConfig) => void;
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

/** `/pi-git` — no arg opens the settings panel; `/pi-git <off|notify|block>` sets the mode directly. */
export function buildGitCommand(deps: CommandDeps) {
  return {
    name: "pi-git" as const,
    options: {
      description: "Configure pi-git: '/pi-git' opens the settings panel; or '/pi-git <off|notify|block>'.",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = MODES.filter((m) => m.startsWith(argumentPrefix)).map((m) => ({ value: m, label: m }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const arg = args.trim();
        const cfg = deps.loadConfig();

        if (arg) {
          if (!(MODES as readonly string[]).includes(arg)) {
            ctx?.ui?.notify?.(`[pi-git] invalid mode "${arg}" (use: ${MODES.join(", ")})`, "error");
            return;
          }
          deps.saveConfig({ ...cfg, mode: arg as Mode });
          ctx?.ui?.notify?.(`[pi-git] mode set to: ${arg}`, "info");
          return;
        }

        if (ctx.mode !== "tui") {
          ctx?.ui?.notify?.(
            `[pi-git] mode: ${cfg.mode} · worktrees.auto: ${cfg.worktrees.auto} · baseDir: ${cfg.worktrees.baseDir}`,
            "info",
          );
          return;
        }

        const items: SettingItem[] = [
          { id: "mode", label: "Mode", currentValue: cfg.mode, values: [...MODES] },
          {
            id: "auto",
            label: "Worktree isolation",
            currentValue: cfg.worktrees.auto ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "basedir",
            label: "Worktree dir",
            currentValue: cfg.worktrees.baseDir,
            values: [...new Set([cfg.worktrees.baseDir, ".pi/worktrees"])],
          },
        ];
        const apply = (id: string, val: string): void => {
          const c = deps.loadConfig();
          if (id === "mode") deps.saveConfig({ ...c, mode: val as Mode });
          else if (id === "auto") deps.saveConfig({ ...c, worktrees: { ...c.worktrees, auto: val === "on" } });
          else if (id === "basedir") deps.saveConfig({ ...c, worktrees: { ...c.worktrees, baseDir: val } });
        };
        await openSettingsPanel(ctx, "pi-git · settings", "auto-checkpoint each turn; worktrees for pi-spawn", items, apply);
      },
    },
  };
}
