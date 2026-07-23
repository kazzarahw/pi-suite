import { test, expect } from "bun:test";
import { parseVerify, formatVerify } from "../src/verify.ts";

test("parseVerify passes on exit 0", () => {
  const r = parseVerify("2 pass", "", 0);
  expect(r.passed).toBe(true);
  expect(r.failures).toEqual([]);
});

test("parseVerify extracts pytest FAILED names", () => {
  const r = parseVerify("FAILED tests/test_a.py::test_one - AssertionError\nFAILED tests/test_a.py::test_two", "", 1);
  expect(r.passed).toBe(false);
  expect(r.failures).toEqual(["tests/test_a.py::test_one", "tests/test_a.py::test_two"]);
});

test("parseVerify extracts bun/jest fail markers", () => {
  const r = parseVerify("(fail) adds numbers\n✗ handles empty", "", 1);
  expect(r.failures).toContain("adds numbers");
  expect(r.failures).toContain("handles empty");
});

test("formatVerify wraps result in a <pi-lens> block", () => {
  const failed = formatVerify({ passed: false, failures: ["t1"], raw: "" });
  expect(failed).toContain("<pi-lens>");
  expect(failed).toContain("t1");
  expect(formatVerify({ passed: true, failures: [], raw: "" })).toContain("passed");
});
