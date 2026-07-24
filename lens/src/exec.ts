import { execFile } from "node:child_process";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts?.cwd, signal: opts?.signal, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
