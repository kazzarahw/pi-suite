import { injectionBlock, injectionHeader } from "pi-shared";
import type { ExecFn } from "./exec.ts";

export interface VerifyResult {
  passed: boolean;
  failures: string[];
  raw: string;
}

/** Parse a test/build command's output into pass/fail + failing-test names. Pure, heuristic. */
export function parseVerify(stdout: string, stderr: string, code: number): VerifyResult {
  const raw = `${stdout}\n${stderr}`.trim();
  const passed = code === 0;
  const failures: string[] = [];

  // pytest / go: "FAILED path::name ..." or "--- FAIL: TestName"
  for (const m of raw.matchAll(/(?:FAILED|--- FAIL:)\s+(\S+)/g)) failures.push(m[1]!);
  // bun / jest / vitest / tap: "(fail) name", "✗ name", "× name", "✕ name"
  for (const m of raw.matchAll(/(?:\(fail\)|✗|×|✕|✘)\s+(.+)/g)) failures.push(m[1]!.replace(/\s*\[[^\]]*\]\s*$/, "").trim());

  const unique = [...new Set(failures.filter(Boolean))];
  return { passed, failures: unique, raw };
}

/** Format a verify result as a `<pi-lens>` block. Pure. */
export function formatVerify(r: VerifyResult): string {
  const header = injectionHeader("lens", r.passed ? "verify passed" : "verify failed");
  if (r.passed) return injectionBlock("lens", header, "  ✓ tests/build passed");
  const body =
    r.failures.length > 0
      ? r.failures.map((f) => `  ✗ ${f}`).join("\n")
      : "  ✗ verify failed (non-zero exit; see output)";
  return injectionBlock("lens", header, body);
}

/** Run a verify command (via `sh -c`) and parse the result. */
export async function runVerify(
  cmd: string,
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const { stdout, stderr, code } = await exec("sh", ["-c", cmd], { cwd, signal });
  return parseVerify(stdout, stderr, code);
}
