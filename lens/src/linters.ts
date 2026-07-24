import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "./diagnostics.ts";
import type { ExecFn } from "./exec.ts";

export interface LinterSpec {
  name: string;
  cmd: (file: string) => string[];
  parse: (stdout: string, stderr: string) => Diagnostic[];
  /** Optional gate: only run when this returns true for the project cwd (omitted = always on). */
  enabledFor?: (cwd: string) => boolean;
}

/** Run each linter spec against a file and flatten the diagnostics. Specs gated off by `enabledFor` are
 *  skipped before spawning; a crashing linter yields []. */
export async function runLinters(
  path: string,
  specs: LinterSpec[],
  exec: ExecFn,
  cwd: string,
): Promise<Diagnostic[]> {
  const active = specs.filter((spec) => !spec.enabledFor || spec.enabledFor(cwd));
  const groups = await Promise.all(
    active.map(async (spec) => {
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

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.json",
  ".eslintrc",
];

/** True when the project has an eslint config (flat, legacy, or a package.json `eslintConfig` key). */
export function hasEslintConfig(cwd: string): boolean {
  if (ESLINT_CONFIG_FILES.some((f) => existsSync(join(cwd, f)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { eslintConfig?: unknown };
    return pkg.eslintConfig != null;
  } catch {
    return false;
  }
}

/** ESLint JSON output → Diagnostic[]. Gated on an eslint config — it no-ops/errors without one. */
export const ESLINT: LinterSpec = {
  name: "eslint",
  cmd: (file) => ["eslint", "--format", "json", file],
  enabledFor: hasEslintConfig,
  parse: (stdout) => {
    try {
      const files = JSON.parse(stdout) as Array<{
        filePath?: string;
        messages?: Array<{
          line?: number;
          column?: number;
          severity?: number;
          message?: string;
          ruleId?: string | null;
        }>;
      }>;
      const out: Diagnostic[] = [];
      for (const f of files) {
        for (const m of f.messages ?? []) {
          out.push({
            file: f.filePath ?? "",
            line: m.line ?? 1,
            col: m.column ?? 1,
            severity: m.severity === 2 ? "error" : "warning",
            message: m.message ?? "",
            source: "eslint",
            code: m.ruleId ?? undefined,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  },
};

/** ShellCheck JSON output → Diagnostic[]. */
export const SHELLCHECK: LinterSpec = {
  name: "shellcheck",
  cmd: (file) => ["shellcheck", "--format=json", file],
  parse: (stdout) => {
    try {
      const arr = JSON.parse(stdout) as Array<{
        file?: string;
        line?: number;
        column?: number;
        level?: string;
        code?: number;
        message?: string;
      }>;
      return arr.map((d) => ({
        file: d.file ?? "",
        line: d.line ?? 1,
        col: d.column ?? 1,
        severity: d.level === "error" ? "error" : d.level === "warning" ? "warning" : "info",
        message: d.message ?? "",
        source: "shellcheck",
        code: d.code != null ? `SC${d.code}` : undefined,
      }));
    } catch {
      return [];
    }
  },
};
