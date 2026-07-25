import { test, expect } from "bun:test";
import { parseVerify, formatVerify, chooseVerifyCommand, runVerify } from "../src/verify.ts";
import type { ExecFn } from "../../shared/exec.ts";

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

// --- Trust gate ------------------------------------------------------------
// agent_settled ran `cfg.verifyCmd || autodetectVerify(cwd)` through `sh -c` with no
// trust check anywhere in the suite. The autodetected command is read out of the
// repository — bun.lock implies "bun test", a scripts.test implies "npm test" — so
// opening a hostile repo and letting the agent make one edit was enough to execute it.

test("an autodetected command is skipped in an untrusted project", () => {
  expect(chooseVerifyCommand({ configured: "", detected: "bun test", trusted: false })).toEqual({
    run: null,
    reason: "untrusted-autodetect",
  });
});

test("an autodetected command runs in a trusted project", () => {
  expect(chooseVerifyCommand({ configured: "", detected: "bun test", trusted: true })).toEqual({
    run: "bun test",
    source: "detected",
  });
});

// The user typed this one; it did not come from the repository. Gating it too would
// silently break a deliberate setting in every not-yet-trusted project.
test("an explicitly configured command runs even when untrusted", () => {
  expect(chooseVerifyCommand({ configured: "make check", detected: "bun test", trusted: false })).toEqual({
    run: "make check",
    source: "configured",
  });
});

test("nothing configured and nothing detected means no command, not a trust problem", () => {
  expect(chooseVerifyCommand({ configured: "", detected: null, trusted: false })).toEqual({
    run: null,
    reason: "none",
  });
});

// --- Verify deadline -------------------------------------------------------

test("a verify killed at its deadline reports the timeout, not a test verdict", async () => {
  const exec: ExecFn = async () => ({ stdout: "ran 3 tests", stderr: "", code: 1, killed: true });
  const r = await runVerify("bun test", exec, "/tmp", undefined, 5000);
  expect(r.passed).toBe(false);
  // Must not be parsed as failing tests — the suite may never have finished.
  expect(r.failures.join(" ")).toContain("timed out");
});

test("verify forwards cwd, signal, and timeout to exec", async () => {
  let seen: { cwd?: string; signal?: AbortSignal; timeout?: number } | undefined;
  const exec: ExecFn = async (_cmd, _args, opts) => {
    seen = opts;
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  const ac = new AbortController();
  await runVerify("bun test", exec, "/tmp/project", ac.signal, 1234);
  expect(seen?.cwd).toBe("/tmp/project");
  expect(seen?.signal).toBe(ac.signal);
  expect(seen?.timeout).toBe(1234);
});
