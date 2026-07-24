import { defaultExec, type ExecFn } from "../../shared/exec.ts";

/** Injectable subprocess runner, so tests never spawn a real `claude`. */
export type RunFn = ExecFn;

export interface RunConsultOptions {
  model: string;
  prompt: string;
  signal?: AbortSignal;
  run?: RunFn;
}

/**
 * Run `claude -p <prompt> --model <model>` and return the trimmed advice.
 * Throws with the captured stderr when claude exits non-zero.
 */
export async function runConsult(opts: RunConsultOptions): Promise<string> {
  const run = opts.run ?? defaultExec;
  const args = ["-p", opts.prompt, "--model", opts.model];
  const { stdout, stderr, code } = await run("claude", args, { signal: opts.signal });
  if (code !== 0) {
    throw new Error(`[pi-consult] claude exited with code ${code}: ${stderr.trim() || "(no stderr)"}`);
  }
  return stdout.trim();
}
