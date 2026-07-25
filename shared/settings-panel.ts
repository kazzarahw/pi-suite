/**
 * The suite's `/pi-<name>` settings panel.
 *
 * One implementation, previously copy-pasted into all seven `command.ts` files.
 * Every `/pi-<name>` with no arguments opens this: a `/settings`-style,
 * arrow-navigable list whose values cycle with Space/Enter and save on each
 * toggle, closing on Esc.
 */
import { getSettingsListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

/**
 * Open a `/settings`-style toggle panel: an arrow-navigable list of `items`, each cycling through its
 * `values`. `apply(id, value)` persists a single change (fires on every toggle). Requires TUI mode —
 * callers must gate on `ctx.mode === "tui"` and fall back to a text readout otherwise.
 */
export async function openSettingsPanel(
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
          // DO NOT REMOVE: every line a custom `ctx.ui.custom` component renders must be
          // truncated to the `width` argument. Rendering wider than the terminal crashes
          // pi outright with "Rendered line N exceeds terminal width" — this bit the lens
          // health readout in a live session and is not caught by any automated test.
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
