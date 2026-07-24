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
  /** Extra environment, merged **over** `process.env` (never replacing it). */
  env?: Record<string, string>;
  /** Abort signal; an abort settles the promise with a non-zero code. */
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Output cap for a single command. The larger of the pre-consolidation values (see spec D5). */
export const MAX_BUFFER = 64 * 1024 * 1024;

export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        signal: opts?.signal,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        // When a spawn fails outright (ENOENT, abort) there is no stderr — surface the
        // error message instead, so callers can report something more useful than "".
        const err = stderr && stderr.length > 0 ? stderr : error ? (error as Error).message : "";
        resolve({ stdout: stdout ?? "", stderr: err, code });
      },
    );
  });
