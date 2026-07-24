import { execFile } from "node:child_process";

/** Injectable subprocess runner so tests never spawn a real `claude`. */
export type RunFn = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface RunConsultOptions {
  model: string;
  prompt: string;
  signal?: AbortSignal;
  run?: RunFn;
}

/** Default runner: `execFile` wrapped so a non-zero exit resolves (not rejects) with its code. */
const defaultRun: RunFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { signal: opts.signal, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });

/**
 * Run `claude -p <prompt> --model <model>` and return the trimmed advice.
 * Throws with the captured stderr when claude exits non-zero.
 */
export async function runConsult(opts: RunConsultOptions): Promise<string> {
  const run = opts.run ?? defaultRun;
  const args = ["-p", opts.prompt, "--model", opts.model];
  const { stdout, stderr, code } = await run("claude", args, { signal: opts.signal });
  if (code !== 0) {
    throw new Error(`[pi-consult] claude exited with code ${code}: ${stderr.trim() || "(no stderr)"}`);
  }
  return stdout.trim();
}
