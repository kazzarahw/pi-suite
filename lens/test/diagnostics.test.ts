import { test, expect } from "bun:test";
import { mergeDiagnostics, formatDiagnostics, formatFormatted, type Diagnostic } from "../src/diagnostics.ts";

const d = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  file: "a.ts",
  line: 1,
  col: 1,
  severity: "error",
  message: "boom",
  source: "ts",
  ...over,
});

test("mergeDiagnostics dedups identical entries and sorts by position", () => {
  const merged = mergeDiagnostics([d({ line: 5 }), d({ line: 2 })], [d({ line: 5 })]);
  expect(merged.map((x) => x.line)).toEqual([2, 5]);
});

test("formatDiagnostics returns '' when clean, a <pi-lens> block otherwise", () => {
  expect(formatDiagnostics("a.ts", [])).toBe("");
  const out = formatDiagnostics("a.ts", [d({ line: 3, col: 7, message: "undefined x", code: "ts2304" })]);
  expect(out).toContain("<pi-lens>");
  expect(out).toContain("3:7");
  expect(out).toContain("undefined x");
  expect(out).toContain("ts2304");
});

test("formatFormatted builds a <pi-lens> reformat note", () => {
  expect(formatFormatted("src/a.ts", "prettier")).toBe(
    "<pi-lens>\nlens · formatted src/a.ts\n  ✓ reformatted with prettier\n</pi-lens>",
  );
});
