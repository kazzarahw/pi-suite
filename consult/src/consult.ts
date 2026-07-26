import { defaultExec, type ExecFn } from "../../shared/exec.ts";

/** Injectable subprocess runner, so tests never spawn a real `claude`. */
export type RunFn = ExecFn;

export interface RunConsultOptions {
  model: string;
  prompt: string;
  /**
   * The project to consult *about* — `cwdOf(ctx)`.
   *
   * Required, and not cosmetic: `claude` is itself a coding agent that reads the
   * directory it starts in. Without this it inherited the extension host's
   * `process.cwd()`, so the second opinion was formed from a different project's
   * files and CLAUDE.md than the one the question was about — while sounding
   * perfectly authoritative.
   */
  cwd: string;
  signal?: AbortSignal;
  run?: RunFn;
}

/**
 * Run `claude -p <prompt> --model <model>` in `cwd` and return the trimmed advice.
 * Throws with the captured stderr when claude exits non-zero.
 */
export async function runConsult(opts: RunConsultOptions): Promise<string> {
  const run = opts.run ?? defaultExec;
  const args = ["-p", opts.prompt, "--model", opts.model];
  const { stdout, stderr, code } = await run("claude", args, { cwd: opts.cwd, signal: opts.signal });
  if (code !== 0) {
    throw new Error(`[pi-consult] claude exited with code ${code}: ${stderr.trim() || "(no stderr)"}`);
  }
  return stdout.trim();
}
