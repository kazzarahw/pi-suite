import { test, expect } from "bun:test";
import {
  mergeDiagnostics,
  formatDiagnostics,
  formatFormatted,
  formatStandingContext,
  summarizeForStatus,
  type Diagnostic,
} from "../src/diagnostics.ts";

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

// Pi's docs say tools MUST truncate; the suite truncated nowhere. A single bulk edit
// can emit thousands of diagnostics, all of which went into context.
test("a large diagnostics block is truncated, and a small one is byte-identical", () => {
  const many: Diagnostic[] = Array.from({ length: 4000 }, (_, i) => ({
    file: "/a.ts",
    line: i + 1,
    col: 1,
    severity: "warning" as const,
    message: `issue ${i}`,
    source: "ts",
  }));
  const big = formatDiagnostics("a.ts", many);
  expect(big).toMatch(/truncated/i);
  expect(big.split("\n").length).toBeLessThan(2100);
  // The header still reports the true total, so the count is never misleading.
  expect(big).toContain("4000 warning(s)");

  const few = formatDiagnostics("a.ts", many.slice(0, 3));
  expect(few).not.toMatch(/truncated/i);
});

// --- The footer summary ----------------------------------------------------
//
// The `<pi-lens>` block lands in the tool result, which Pi renders with its own built-in
// renderer — a diff for an edit, file content for a read. Every diagnostic pi-lens
// produced was therefore invisible to the person watching, which reads exactly like an
// extension that is not running.

test("summarizeForStatus counts errors and warnings against the file's basename", () => {
  const ds = [d(), d({ line: 2, severity: "warning" }), d({ line: 3, severity: "warning" })];
  expect(summarizeForStatus("src/deep/math.ts", ds)).toBe("lens: 1 error, 2 warnings in math.ts");
});

test("summarizeForStatus pluralises, and omits a category with nothing in it", () => {
  expect(summarizeForStatus("a.ts", [d(), d({ line: 2 })])).toBe("lens: 2 errors in a.ts");
  expect(summarizeForStatus("a.ts", [d({ severity: "warning" })])).toBe("lens: 1 warning in a.ts");
});

test("summarizeForStatus says nothing about a clean file", () => {
  // A footer reading "0 errors" after every read is noise; the caller clears the line.
  expect(summarizeForStatus("a.ts", [])).toBeUndefined();
});

// --- The standing context --------------------------------------------------
//
// Every other pi-lens output is reactive — appended to a result the agent already has.
// None of it says the feedback is automatic, so an agent with no standing knowledge of
// pi-lens assumes nothing is watching and runs the type-checker itself.

test("formatStandingContext states that silence means clean", () => {
  const block = formatStandingContext("bun test");
  expect(block).toContain("<pi-lens>");
  expect(block).toContain("automatically");
  // The load-bearing sentence: without it, "no diagnostics" is ambiguous between clean
  // and not-running, and an agent resolves that ambiguity by checking by hand.
  expect(block).toContain("clean");
  expect(block).toContain("bun test");
});

test("formatStandingContext omits the verify line when there is no command", () => {
  const block = formatStandingContext(null);
  expect(block).toContain("automatically");
  expect(block).not.toContain("runs automatically and the result is reported");
});

test("the standing context stays short enough to sit on every call", () => {
  // Prepended to every LLM request, so its cost is paid per call for the whole session.
  expect(formatStandingContext("bun test").split("\n").length).toBeLessThanOrEqual(8);
});
