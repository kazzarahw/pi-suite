import { test, expect } from "bun:test";
import { RUFF, runLinters } from "../src/linters.ts";
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
  const ds = await runLinters("a.py", [RUFF], exec);
  expect(ds).toHaveLength(1);
  expect(ds[0]!.source).toBe("ruff");
});
