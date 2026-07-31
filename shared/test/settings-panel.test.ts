import { test, expect, beforeAll } from "bun:test";
import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type SettingItem } from "@earendil-works/pi-tui";
import { openSettingsPanel, textEntry } from "../settings-panel.ts";

// The panel calls `getSettingsListTheme()`, which throws unless Pi's global theme has
// been initialized. In a real session the TUI does that during startup; here it is one
// call, and it is the reason this file could not simply be written against the harness.
beforeAll(() => {
  initTheme();
});

/**
 * The `/pi-<name>` settings panel, shared by all seven commands.
 *
 * It sat at 4.55% line coverage — the single least-tested file in the suite, and the one
 * every command depends on. The width clipping in particular is guarded by a comment
 * reading "DO NOT REMOVE" because rendering a line wider than the terminal crashes Pi
 * outright with "Rendered line N exceeds terminal width". That happened in a live
 * session and no automated test would have caught it. Now one does.
 */

const ITEMS: SettingItem[] = [
  { id: "mode", label: "Mode", currentValue: "notify", values: ["off", "notify", "block"] },
  { id: "detect", label: "Detect changes", currentValue: "on", values: ["on", "off"] },
];

interface Rendered {
  /** The component `ctx.ui.custom` was handed, driven directly. */
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/** Capture the component the panel builds, without a real TUI. */
function capture(): {
  ctx: ExtensionCommandContext;
  component(): Rendered;
  renders: number;
  finish(): void;
} {
  let component: Rendered | undefined;
  let done: (v: unknown) => void = () => {};
  const state = { renders: 0 };
  const tui = {
    requestRender: () => {
      state.renders += 1;
    },
  };
  const theme = {
    fg: (_c: string, s: string) => s,
    bold: (s: string) => s,
  };
  const ctx = {
    mode: "tui",
    ui: {
      notify: () => {},
      custom: async (build: (t: unknown, th: unknown, kb: unknown, d: (v: unknown) => void) => Rendered) => {
        done = (v) => v;
        component = build(tui, theme, {}, (v) => done(v));
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    component: () => component!,
    get renders() {
      return state.renders;
    },
    finish: () => done(undefined),
  };
}

test("opening the panel builds a component and resolves", async () => {
  const cap = capture();
  await openSettingsPanel(cap.ctx, "pi-demo · settings", "a subtitle", ITEMS, () => {});
  expect(cap.component()).toBeDefined();
});

test("the header renders the title and subtitle", async () => {
  const cap = capture();
  await openSettingsPanel(cap.ctx, "pi-demo · settings", "a subtitle", ITEMS, () => {});
  const lines = cap.component().render(80);
  expect(lines[0]).toContain("pi-demo · settings");
  expect(lines[1]).toContain("a subtitle");
});

/**
 * Visible width, ignoring colour codes.
 *
 * A rendered line carries ANSI escapes, so its raw `.length` is several times its
 * on-screen width — measuring that instead is how this test first "failed" against
 * output that was in fact well within bounds.
 */
const visible = (line: string): number => line.replace(/\[[0-9;]*m/g, "").length;

/** The lines `settings-panel.ts` renders itself: title, subtitle, spacer. */
const HEADER_LINES = 3;

/**
 * The crash guard, on the part this file owns.
 *
 * The header is the component `openSettingsPanel` builds, and it is where the live crash
 * happened: pi-lens's health readout is a list of missing tool names, long enough to
 * exceed a normal terminal, and a line wider than the terminal takes Pi down with
 * "Rendered line N exceeds terminal width" rather than wrapping.
 */
test("the header never renders wider than the width it was given", async () => {
  const cap = capture();
  const longTitle = "pi-demo · settings ".repeat(20);
  const longSubtitle = "missing tools: ".repeat(30);
  await openSettingsPanel(cap.ctx, longTitle, longSubtitle, ITEMS, () => {});

  for (const width of [1, 2, 3, 10, 20, 40, 80, 120]) {
    for (const line of cap.component().render(width).slice(0, HEADER_LINES)) {
      expect(visible(line)).toBeLessThanOrEqual(width);
    }
  }
});

test("nothing the panel renders exceeds a realistic terminal width", async () => {
  // The whole component, list rows included, at widths a terminal actually takes.
  const cap = capture();
  await openSettingsPanel(cap.ctx, "pi-demo · settings", "missing tools: eslint, ruff", ITEMS, () => {});
  for (const width of [40, 80, 120]) {
    for (const line of cap.component().render(width)) {
      expect(visible(line)).toBeLessThanOrEqual(width);
    }
  }
});

test("a zero width produces no negative slice and no throw", async () => {
  // `width - 1` is the clip bound, so a zero width must floor rather than wrap around.
  const cap = capture();
  await openSettingsPanel(cap.ctx, "a title", "a subtitle", ITEMS, () => {});
  expect(() => cap.component().render(0)).not.toThrow();
  for (const line of cap.component().render(0).slice(0, HEADER_LINES)) {
    expect(visible(line)).toBe(0);
  }
});

test("a title that already fits is rendered unclipped", async () => {
  const cap = capture();
  await openSettingsPanel(cap.ctx, "short", "also short", ITEMS, () => {});
  expect(cap.component().render(80)[0]).toBe("short");
});

test("input is forwarded to the list and asks for a repaint", async () => {
  const cap = capture();
  await openSettingsPanel(cap.ctx, "t", "s", ITEMS, () => {});
  cap.component().handleInput(" ");
  expect(cap.renders).toBeGreaterThan(0);
});

test("invalidate does not throw", async () => {
  const cap = capture();
  await openSettingsPanel(cap.ctx, "t", "s", ITEMS, () => {});
  expect(() => cap.component().invalidate()).not.toThrow();
});

test("an empty item list still renders a header rather than throwing", async () => {
  // Reachable: an extension whose every field is conditional could hand over nothing.
  const cap = capture();
  await openSettingsPanel(cap.ctx, "t", "s", [], () => {});
  expect(cap.component().render(40).length).toBeGreaterThanOrEqual(3);
});

// ---------------------------------------------------------------------------
// The text field, for the rows a cycle cannot express.
//
// `SettingsList` changes a row by stepping through the `values` it was handed, which cannot
// express a value nobody can enumerate. pi-telegram's bot token proved it: the only string a panel
// could offer for a credential it has never seen is the placeholder meaning *unset*, so the row
// cycled `(not set)` → `(not set)` and the token had to be hand-edited into the JSON file.
// ---------------------------------------------------------------------------

test("the text field submits what was typed", () => {
  const seen: Array<string | undefined> = [];
  const field = textEntry({ label: "Token", initial: "", done: (v) => seen.push(v) });
  for (const ch of "abc") field.handleInput?.(ch);
  field.handleInput?.("\n");
  expect(seen).toEqual(["abc"]);
});

/**
 * The cursor starts at the end of a prefilled value.
 *
 * `Input.setValue` *clamps* the cursor rather than moving it, and a fresh `Input` has it at 0 — so
 * without correcting it the first character typed would land at the front of the existing value.
 */
test("typing into a prefilled field appends rather than prepends", () => {
  const seen: Array<string | undefined> = [];
  const field = textEntry({ label: "Command", initial: "bun", done: (v) => seen.push(v) });
  for (const ch of " test") field.handleInput?.(ch);
  field.handleInput?.("\n");
  expect(seen).toEqual(["bun test"]);
});

test("escape cancels without a value", () => {
  const seen: Array<string | undefined> = [];
  const field = textEntry({ label: "Token", initial: "x", done: (v) => seen.push(v) });
  field.handleInput?.("\x1b");
  expect(seen).toEqual([undefined]);
});

/**
 * A blank submission is a value everywhere except on a credential.
 *
 * A secret opens *blank* because it may never be rendered, so Enter on an untouched field would
 * read as a confirmation and land as a deletion of the token.
 */
test("blankIsCancel separates an empty value from an untouched credential", () => {
  const plain: Array<string | undefined> = [];
  textEntry({ label: "Cmd", initial: "", done: (v) => plain.push(v) }).handleInput?.("\n");
  expect(plain).toEqual([""]);

  const secret: Array<string | undefined> = [];
  textEntry({
    label: "Token",
    initial: "",
    blankIsCancel: true,
    done: (v) => secret.push(v),
  }).handleInput?.("\n");
  expect(secret).toEqual([undefined]);
});

test("every line the text field renders is clipped to the width", () => {
  const field = textEntry({
    label: "A very long label ".repeat(10),
    initial: "y".repeat(300),
    hint: "and a hint that also runs well past the edge of any terminal ".repeat(5),
    done: () => {},
  });
  for (const width of [20, 40, 80]) {
    for (const line of field.render(width)) {
      // `visibleWidth`, not `line.length`: the `Input` draws its cursor with a reverse-video
      // escape sequence, so the *string* is legitimately longer than the column it occupies.
      // Pi's own limit is on columns — measuring characters here would fail a correct render and,
      // worse, invite someone to "fix" it by clipping the escape codes in half.
      // DO NOT RELAX: a line wider than the terminal crashes pi outright.
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
  field.invalidate();
});
