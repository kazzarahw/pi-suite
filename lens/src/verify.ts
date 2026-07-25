import { injectionBlock, injectionHeader } from "../../shared/index.ts";
import type { ExecFn } from "../../shared/exec.ts";

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

/** What the trust gate decided, and why. */
export type VerifyChoice =
  | { run: string; source: "configured" | "detected" }
  | { run: null; reason: "none" | "untrusted-autodetect" };

/**
 * Choose the verify command for this settle, honoring project trust.
 *
 * An **autodetected** command is read out of the repository — `bun.lock` implies
 * `bun test`, a `scripts.test` implies `npm test` — so running it in an untrusted
 * project executes whatever that repository decided, from nothing more than opening
 * it and letting the agent make one edit. That path is gated.
 *
 * An **explicitly configured** command still runs. The user typed it; it did not come
 * from the repository, and it is theirs to decide. Gating it too would silently break
 * a deliberate setting in every project not yet trusted.
 *
 * Pure, so the policy is testable without spawning anything.
 */
export function chooseVerifyCommand(opts: {
  configured: string;
  detected: string | null;
  trusted: boolean;
}): VerifyChoice {
  if (opts.configured) return { run: opts.configured, source: "configured" };
  if (!opts.detected) return { run: null, reason: "none" };
  if (!opts.trusted) return { run: null, reason: "untrusted-autodetect" };
  return { run: opts.detected, source: "detected" };
}

/** Run a verify command (via `sh -c`) and parse the result. */
export async function runVerify(
  cmd: string,
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal,
  timeout?: number,
): Promise<VerifyResult> {
  const { stdout, stderr, code, killed } = await exec("sh", ["-c", cmd], { cwd, signal, timeout });
  // A command killed at its deadline has not "failed" — it never finished. Reporting
  // a partial transcript as a verdict would tell the agent tests failed when they may
  // not have run at all.
  if (killed) return { passed: false, failures: [`verify timed out after ${timeout ?? "the default"}ms`], raw: `${stdout}\n${stderr}`.trim() };
  return parseVerify(stdout, stderr, code);
}
