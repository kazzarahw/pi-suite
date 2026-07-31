/**
 * The suite's `/pi-<name>` settings panel.
 *
 * One implementation, previously copy-pasted into all seven `command.ts` files.
 * Every `/pi-<name>` with no arguments opens this: a `/settings`-style,
 * arrow-navigable list whose values cycle with Space/Enter and save on each
 * toggle, closing on Esc.
 *
 * **Cycling is not enough for every field, and pretending it was made one field
 * unreachable.** `SettingsList` changes a row by stepping through the `values` array it was
 * handed, which is exactly right for a mode, a boolean, or a byte count with three sensible
 * presets — and cannot express a value nobody can enumerate. pi-telegram's bot token is the
 * case that proves it: the only string a panel could offer for a credential it has never seen
 * is the placeholder standing in for *unset*, so the row cycled from `(not set)` to `(not set)`
 * and the user hand-edited `~/.pi/agent/pi-telegram.json` to install the token. A settings
 * panel that cannot set a setting is worse than no panel, because it reads as one that works.
 *
 * `SettingItem.submenu` is the seam pi-tui already provides for this and the suite never used:
 * Enter opens a component of our choosing, and whatever it passes to `done` becomes the row's
 * value. {@link textEntry} is that component.
 */
import { getSettingsListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";

/**
 * DO NOT REMOVE: every line a custom `ctx.ui.custom` component renders must be truncated to
 * the `width` argument. Rendering wider than the terminal crashes pi outright with
 * "Rendered line N exceeds terminal width" — this bit the lens health readout in a live
 * session and is not caught by any automated test.
 */
const clip = (s: string, width: number): string =>
  s.length > width ? s.slice(0, Math.max(0, width - 1)) : s;

export interface TextEntryOptions {
  /** Row label, shown above the field. */
  readonly label: string;
  /** What the field starts with. Empty for a credential — see {@link textEntry}. */
  readonly initial: string;
  /** One line under the field: what a blank submission means, presets worth knowing. */
  readonly hint?: string;
  /** Enter with a value, or Esc / an unusable submission, which passes `undefined`. */
  readonly done: (value?: string) => void;
  /** Treat a blank submission as a cancel rather than a write. */
  readonly blankIsCancel?: boolean;
}

/**
 * A single-line text field, for a value no list of presets can hold.
 *
 * Handed to `SettingItem.submenu`, so `SettingsList` routes all input here while it is open
 * and restores the row when `done` fires.
 *
 * `blankIsCancel` exists for credentials. Everywhere else an empty submission is a real
 * value — it is how a field with a placeholder returns to `(autodetect)` or `(not set)` — but
 * a secret is prefilled *blank* precisely because it must never be rendered, which means Enter
 * on an untouched field would look like a confirmation and land as a deletion. The token is
 * cleared through `/pi-<name> <verb>` with no argument instead, which the hint says.
 */
export function textEntry(opts: TextEntryOptions): Component {
  const input = new Input();
  input.setValue(opts.initial);
  // `setValue` clamps the cursor rather than moving it — `Math.min(cursor, length)` — and a
  // fresh `Input` has it at 0, so a prefilled field would take the first character typed at
  // the *front* of the existing value. `ctrl+e` is `tui.editor.cursorLineEnd`, which is the
  // only way in from out here: the cursor is private and there is no setter.
  input.handleInput("\x05");
  input.focused = true;
  input.onSubmit = (value: string): void => {
    const trimmed = value.trim();
    opts.done(opts.blankIsCancel && trimmed === "" ? undefined : trimmed);
  };
  input.onEscape = (): void => opts.done(undefined);

  return {
    render(width: number): string[] {
      const lines = [clip(opts.label, width), ...input.render(width)];
      if (opts.hint) lines.push(clip(opts.hint, width));
      lines.push(clip("  Enter to save · Esc to cancel", width));
      return lines;
    },
    handleInput(data: string): void {
      input.handleInput(data);
    },
    invalidate(): void {
      input.invalidate();
    },
  };
}

/**
 * What a row change did, so the panel can show the *stored* value rather than the typed one.
 *
 * `SettingsList` sets `currentValue` to whatever `done` returned before it calls back, which
 * is wrong twice over: a secret would then render the credential the caller went to the
 * trouble of masking, and a field with a placeholder would render `""` instead of
 * `(autodetect)`. Returning the display string lets the caller correct the row — it owns the
 * `displayValue`/`parseValue` pair and is the only thing that can say what was actually kept.
 */
export type ApplyResult = string | void;

/**
 * Open a `/settings`-style toggle panel: an arrow-navigable list of `items`, each cycling through its
 * `values` — or, for an item carrying a `submenu`, opening that. `apply(id, value)` persists a single
 * change (fires on every toggle) and may return the display string to show for it. Requires TUI mode —
 * callers must gate on `ctx.mode === "tui"` and fall back to a text readout otherwise.
 */
export async function openSettingsPanel(
  ctx: ExtensionCommandContext,
  title: string,
  subtitle: string,
  items: SettingItem[],
  apply: (id: string, value: string) => ApplyResult,
): Promise<void> {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new (class {
        render(width: number): string[] {
          return [
            theme.fg("accent", theme.bold(clip(title, width))),
            theme.fg("muted", clip(subtitle, width)),
            "",
          ];
        }
        invalidate(): void {}
      })(),
    );
    const list = new SettingsList(
      items,
      Math.min(items.length + 4, 15),
      getSettingsListTheme(),
      (id, value) => {
        const display = apply(id, value);
        // Only when the caller said so: `undefined` means "what you were given is what it
        // is", which is the cycling case and needs no correction.
        if (typeof display === "string") list.updateValue(id, display);
        tui.requestRender();
      },
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
