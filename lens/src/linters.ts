import type { Diagnostic } from "./diagnostics.ts";
import type { ExecFn } from "./exec.ts";

export interface LinterSpec {
  name: string;
  cmd: (file: string) => string[];
  parse: (stdout: string, stderr: string) => Diagnostic[];
}

/** Run each linter spec against a file and flatten the diagnostics. A crashing linter yields []. */
export async function runLinters(path: string, specs: LinterSpec[], exec: ExecFn): Promise<Diagnostic[]> {
  const groups = await Promise.all(
    specs.map(async (spec) => {
      const argv = spec.cmd(path);
      const [cmd, ...args] = argv;
      if (!cmd) return [];
      try {
        const { stdout, stderr } = await exec(cmd, args);
        return spec.parse(stdout, stderr);
      } catch {
        return [];
      }
    }),
  );
  return groups.flat();
}

/** Ruff (Python) JSON output → Diagnostic[]. */
export const RUFF: LinterSpec = {
  name: "ruff",
  cmd: (file) => ["ruff", "check", "--output-format", "json", "--quiet", file],
  parse: (stdout) => {
    try {
      const arr = JSON.parse(stdout) as Array<{
        filename?: string;
        location?: { row?: number; column?: number };
        message?: string;
        code?: string;
      }>;
      return arr.map((d) => ({
        file: d.filename ?? "",
        line: d.location?.row ?? 1,
        col: d.location?.column ?? 1,
        severity: "warning" as const,
        message: d.message ?? "",
        source: "ruff",
        code: d.code,
      }));
    } catch {
      return [];
    }
  },
};

/** Default linter specs for a file (LSP covers TS/JS diagnostics; ruff covers Python). */
export function lintersFor(path: string): LinterSpec[] {
  return path.endsWith(".py") ? [RUFF] : [];
}
