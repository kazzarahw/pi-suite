/**
 * The suite's single subprocess runner.
 *
 * Collapses what were four near-identical per-extension copies (pi-lens, pi-git,
 * pi-browser, pi-consult). The contract every caller relies on: this **always
 * resolves, never rejects** — a missing binary, a non-zero exit, or an aborted
 * signal all come back as a result with a non-zero `code`. Callers therefore
 * never need a try/catch to avoid hanging, which is the property pi-lens's
 * diagnostics path depends on.
 */
import { execFile } from "node:child_process";

export interface ExecOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * Extra environment, merged **over** `process.env` (never replacing it).
   *
   * An `undefined` value **removes** that variable from the child. Merging alone
   * cannot express removal, and pi-git needs it: git exports `GIT_DIR`,
   * `GIT_INDEX_FILE` and friends before running hooks, and an inherited value
   * silently redirects every subsequent git call at a different repository.
   */
  env?: Record<string, string | undefined>;
  /** Abort signal; an abort settles the promise with a non-zero code. */
  signal?: AbortSignal;
  /** Deadline in ms. Defaults to `DEFAULT_EXEC_TIMEOUT_MS`. */
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /**
   * True only when the child was killed at its deadline.
   *
   * A killed child still returns whatever it wrote beforehand, so a deadline is
   * otherwise indistinguishable from an ordinary failure. Reporting a bounded wait
   * as a normal result is the same defect as answering a wedged language server
   * query with "(none found)" — callers branch on this field, never on stderr text.
   */
  killed: boolean;
}

export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Output cap for a single command. The larger of the pre-consolidation values (see spec D5). */
export const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Backstop deadline for any command that does not specify one.
 *
 * Generous on purpose: a forgotten call site should degrade to "bounded eventually"
 * rather than "unbounded". Callers with a tighter expectation pass their own.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/** Merge `extra` over `process.env`, deleting keys whose value is `undefined`. */
function buildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  if (!extra) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts?.cwd,
        env: buildEnv(opts?.env),
        signal: opts?.signal,
        timeout: opts?.timeout ?? DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        // On a deadline kill, execFile reports `code: null` with `killed: true`, so the
        // numeric branch falls through to 1 — non-zero, as the contract requires.
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        // When a spawn fails outright (ENOENT, abort) there is no stderr — surface the
        // error message instead, so callers can report something more useful than "".
        const err = stderr && stderr.length > 0 ? stderr : error ? (error as Error).message : "";
        resolve({ stdout: stdout ?? "", stderr: err, code, killed: (error as { killed?: boolean } | null)?.killed === true });
      },
    );
  });
