import { test, expect, beforeAll } from "bun:test";
import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { openSettingsPanel } from "../settings-panel.ts";

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
