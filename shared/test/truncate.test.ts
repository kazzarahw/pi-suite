import { test, expect } from "bun:test";
import { truncateForAgent } from "../truncate.ts";

/**
 * Pi's docs state tools MUST truncate; the suite had zero truncation anywhere, so a
 * large linter run, verify output, page fetch, or subagent transcript went into
 * context whole. Pi's own utilities do the cutting — this wrapper exists so the
 * seven extensions render the result one way instead of seven.
 */

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("short input is returned byte-identical, with no marker", () => {
  const text = "one\ntwo\nthree";
  expect(truncateForAgent(text)).toBe(text);
});

test("empty input is returned unchanged", () => {
  expect(truncateForAgent("")).toBe("");
});

test("input over the line limit is cut and carries a marker", () => {
  const out = truncateForAgent(lines(100), { maxLines: 10 });
  expect(out).toContain("line 1");
  expect(out).not.toContain("line 90");
  expect(out).toMatch(/truncated/i);
});

test("the marker names how much was dropped", () => {
  const out = truncateForAgent(lines(100), { maxLines: 10 });
  // The agent needs to know output was withheld, and roughly how much, to decide
  // whether to go looking for the rest.
  expect(out).toContain("100");
});

test("keep:'tail' retains the end of the input", () => {
  // Verify output puts the failure last; truncating the head of it would drop the
  // only part worth reading.
  const out = truncateForAgent(lines(100), { maxLines: 10, keep: "tail" });
  expect(out).toContain("line 100");
  expect(out).not.toContain("line 1\n");
});

test("keep:'head' is the default", () => {
  expect(truncateForAgent(lines(100), { maxLines: 10 })).toContain("line 1");
});

test("the label appears in the marker when given", () => {
  const out = truncateForAgent(lines(100), { maxLines: 10, label: "diagnostics" });
  expect(out).toContain("diagnostics");
});

test("a byte limit truncates even when the line count is small", () => {
  const out = truncateForAgent("x".repeat(5000) + "\nsecond line", { maxBytes: 100 });
  expect(out.length).toBeLessThan(5000);
  expect(out).toMatch(/truncated/i);
});

test("truncation never splits a line", () => {
  const out = truncateForAgent(lines(100), { maxLines: 10 });
  const body = out.split("\n").filter((l: string) => !/truncated/i.test(l) && l.length > 0);
  for (const l of body) expect(l).toMatch(/^line \d+$/);
});
