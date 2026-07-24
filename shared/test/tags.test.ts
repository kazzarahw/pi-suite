import { test, expect } from "bun:test";
import { TAG_PREFIX, tagName, injectionHeader, injectionBlock } from "../tags.ts";

// pi-shared shipped four exported runtime functions and zero tests. These pin the
// injection format that pi-lens and pi-memory both depend on (HOUSE-STYLE §6).

test("tagName prefixes the short name", () => {
  expect(tagName("lens")).toBe("pi-lens");
  expect(tagName("memory")).toBe("pi-memory");
  expect(TAG_PREFIX).toBe("pi-");
});

test("injectionHeader composes 'source · why'", () => {
  expect(injectionHeader("lens", "diagnostics after edit")).toBe("lens · diagnostics after edit");
});

test("injectionBlock wraps header and body in matching tags", () => {
  const block = injectionBlock("lens", injectionHeader("lens", "why"), "  body line");
  expect(block).toBe("<pi-lens>\nlens · why\n  body line\n</pi-lens>");
});

test("injectionBlock opening and closing tags always match", () => {
  for (const name of ["lens", "memory", "todo"]) {
    const block = injectionBlock(name, "h", "b");
    expect(block.startsWith(`<pi-${name}>\n`)).toBe(true);
    expect(block.endsWith(`\n</pi-${name}>`)).toBe(true);
  }
});

test("injectionBlock preserves multi-line bodies verbatim", () => {
  const body = "  12:5  error  boom\n  13:1  warn   meh";
  expect(injectionBlock("lens", "h", body)).toContain(body);
});
