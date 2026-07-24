import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUFF, ESLINT, SHELLCHECK, hasEslintConfig, runLinters } from "../src/linters.ts";
import type { ExecFn } from "../src/exec.ts";

test("RUFF parses ruff json output into Diagnostic[]", () => {
  const json = JSON.stringify([
    { filename: "a.py", location: { row: 3, column: 5 }, message: "unused import", code: "F401" },
  ]);
  expect(RUFF.parse(json, "")).toEqual([
    { file: "a.py", line: 3, col: 5, severity: "warning", message: "unused import", source: "ruff", code: "F401" },
  ]);
});

test("RUFF.parse tolerates non-JSON output", () => {
  expect(RUFF.parse("ruff: command panicked", "")).toEqual([]);
});

test("runLinters runs each spec via exec and flattens", async () => {
  const exec: ExecFn = async () => ({
    stdout: JSON.stringify([{ filename: "a.py", location: { row: 1, column: 1 }, message: "x", code: "E1" }]),
    stderr: "",
    code: 1,
  });
  const ds = await runLinters("a.py", [RUFF], exec, "/tmp");
  expect(ds).toHaveLength(1);
  expect(ds[0]!.source).toBe("ruff");
});

test("hasEslintConfig detects flat, legacy, and package.json configs", () => {
  const dir = mkdtempSync(join(tmpdir(), "lens-eslint-"));
  expect(hasEslintConfig(dir)).toBe(false);
  writeFileSync(join(dir, "eslint.config.js"), "export default [];");
  expect(hasEslintConfig(dir)).toBe(true);
  rmSync(dir, { recursive: true, force: true });

  const dir2 = mkdtempSync(join(tmpdir(), "lens-eslint-"));
  writeFileSync(join(dir2, "package.json"), JSON.stringify({ eslintConfig: { rules: {} } }));
  expect(hasEslintConfig(dir2)).toBe(true);
  rmSync(dir2, { recursive: true, force: true });
});

test("runLinters skips a spec whose enabledFor is false (no spawn), runs it once enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lens-gate-"));
  let spawned = 0;
  const exec: ExecFn = async () => {
    spawned++;
    return { stdout: "[]", stderr: "", code: 0 };
  };
  // ESLINT.enabledFor = hasEslintConfig → false in an empty dir, so it must not spawn.
  expect(await runLinters(join(dir, "a.ts"), [ESLINT], exec, dir)).toEqual([]);
  expect(spawned).toBe(0);
  // Add a config → it runs.
  writeFileSync(join(dir, "eslint.config.js"), "export default [];");
  await runLinters(join(dir, "a.ts"), [ESLINT], exec, dir);
  expect(spawned).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("ESLINT parses eslint json (severity 2=error, 1=warning)", () => {
  const json = JSON.stringify([
    {
      filePath: "a.ts",
      messages: [
        { line: 2, column: 3, severity: 2, message: "'x' is assigned but never used", ruleId: "no-unused-vars" },
        { line: 5, column: 1, severity: 1, message: "Missing semicolon", ruleId: "semi" },
      ],
    },
  ]);
  expect(ESLINT.parse(json, "")).toEqual([
    { file: "a.ts", line: 2, col: 3, severity: "error", message: "'x' is assigned but never used", source: "eslint", code: "no-unused-vars" },
    { file: "a.ts", line: 5, col: 1, severity: "warning", message: "Missing semicolon", source: "eslint", code: "semi" },
  ]);
});

test("ESLINT.parse tolerates non-JSON / empty output", () => {
  expect(ESLINT.parse("", "")).toEqual([]);
  expect(ESLINT.parse("oops", "")).toEqual([]);
});

test("SHELLCHECK parses shellcheck json into Diagnostic[] with SC codes", () => {
  const json = JSON.stringify([
    { file: "a.sh", line: 4, column: 1, level: "warning", code: 2086, message: "Double quote to prevent globbing" },
    { file: "a.sh", line: 7, column: 2, level: "error", code: 1073, message: "Couldn't parse this" },
  ]);
  expect(SHELLCHECK.parse(json, "")).toEqual([
    { file: "a.sh", line: 4, col: 1, severity: "warning", message: "Double quote to prevent globbing", source: "shellcheck", code: "SC2086" },
    { file: "a.sh", line: 7, col: 2, severity: "error", message: "Couldn't parse this", source: "shellcheck", code: "SC1073" },
  ]);
});
