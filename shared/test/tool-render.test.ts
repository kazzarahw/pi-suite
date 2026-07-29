import { test, expect } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderToolCall } from "../tool-render.ts";

/**
 * A theme that records which slot each fragment was painted in, so the assertions can
 * be about Pi's grammar (name in `toolTitle`+bold, argument in `accent`) rather than
 * about ANSI codes.
 */
const theme = {
  fg: (slot: string, s: string) => `<${slot}>${s}</${slot}>`,
  bold: (s: string) => `<b>${s}</b>`,
} as unknown as Theme;

const rendered = (c: Text): string => c.render(200).join("\n");

test("the name is toolTitle + bold and the detail is accent — Pi's own grammar", () => {
  const out = rendered(renderToolCall("browser", "search pi extensions", theme));
  expect(out).toContain("<toolTitle><b>browser</b></toolTitle>");
  expect(out).toContain("<accent>search pi extensions</accent>");
});

/**
 * With no detail the row must be what Pi's *fallback* renderer draws and nothing more,
 * so a tool with nothing to add still looks like the same kind of object as one that
 * has. (`Text.render` pads each line out to the width it is given; that padding is the
 * component's business, not this function's, hence the trim.)
 */
test("an empty detail renders exactly the fallback row, with no dangling separator", () => {
  const out = rendered(renderToolCall("spawn", "", theme)).trimEnd();
  expect(out).toBe("<toolTitle><b>spawn</b></toolTitle>");
  expect(out).not.toContain("accent");
});

/**
 * Pi's built-ins reuse `context.lastComponent` and call `setText` on it rather than
 * allocating a component per frame; a streaming call re-renders this row repeatedly.
 */
test("a passed-in component is updated in place, not replaced", () => {
  const first = renderToolCall("lens", "hover a.ts:1:1", theme);
  const second = renderToolCall("lens", "hover b.ts:2:2", theme);
  expect(second).not.toBe(first);

  const reused = renderToolCall("lens", "hover c.ts:3:3", theme, first);
  expect(reused).toBe(first);
  expect(rendered(reused)).toContain("hover c.ts:3:3");
  expect(rendered(reused)).not.toContain("hover a.ts:1:1");
});

test("anything that is not a Text is ignored rather than trusted", () => {
  const out = renderToolCall("plan", "3 items", theme, { notAComponent: true });
  expect(out).toBeInstanceOf(Text);
  expect(rendered(out)).toContain("3 items");
});

/**
 * `Text` word-wraps to the width it is handed. This is why the suite can use it rather
 * than `TruncatedText`: the crash rule in shared/README.md is about hand-built
 * `ctx.ui.custom` lines, and an over-wide row here would be that crash.
 */
test("a long detail wraps to the width rather than overflowing it", () => {
  const long = renderToolCall("browser", `open https://example.com/${"x".repeat(300)}`, theme);
  for (const line of long.render(40)) {
    expect(line.replace(/<\/?[a-z]+>/g, "").length).toBeLessThanOrEqual(40);
  }
});
