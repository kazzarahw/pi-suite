import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODE, MODES, type Mode } from "../../shared/index.ts";
import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { bool, oneOf, posNum, str } from "../../shared/fields.ts";

export interface LensConfig {
  /**
   * `off` = manual `lens` tool only. `notify` (default) = inject diagnostics + auto-verify
   * and report. `block` = the same, plus auto-continue the agent on a failed verify.
   *
   * `block` is the **Insist** shape, not Interdict, and that is forced rather than chosen.
   * Interdicting would mean refusing an edit that introduces an error — but the only hook
   * that can return `{ block: true }` is `tool_call`, which fires *before* the write, when
   * the diagnostics being interdicted do not exist yet. There is nothing to refuse at the
   * one moment refusal is possible. What pi-lens actually finds, at settle, is unfinished
   * work, and the strongest honest response to that is to insist the agent keep going.
   * (`shared/README.md` listed pi-lens as the Interdict example for a release in which the
   * string `block: true` appeared nowhere in the suite.)
   */
  mode: Mode;
  /** Test/build command; "" = autodetect (see autodetectVerify). */
  verifyCmd: string;
  /** Auto-format a file after write/edit (default off). Runs the language's formatter in place. */
  autoFormat: boolean;
  /** Warm the language servers on session start so the first read/query is fast (default on). */
  prewarm: boolean;
  /** Deadline for the verify command. Test suites vary hugely, so it is configurable. */
  verifyTimeoutMs: number;
}

export const DEFAULTS: LensConfig = {
  mode: DEFAULT_MODE,
  verifyCmd: "",
  autoFormat: false,
  prewarm: true,
  verifyTimeoutMs: 600_000,
};

export const SPEC: ConfigSpec<LensConfig> = {
  name: "lens",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<LensConfig>;
    return {
      mode: oneOf<Mode>(p.mode, MODES, DEFAULT_MODE),
      verifyCmd: str(p.verifyCmd, defaults.verifyCmd),
      autoFormat: bool(p.autoFormat, defaults.autoFormat),
      prewarm: bool(p.prewarm, defaults.prewarm),
      verifyTimeoutMs: posNum(p.verifyTimeoutMs, defaults.verifyTimeoutMs),
    };
  },
};

/** `<agentDir>/pi-lens.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);

/** Best-effort verify command for a project, or null. Pure-ish (reads the fs). */
export function autodetectVerify(cwd: string): string | null {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun test";
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: { test?: string } };
    if (pkg.scripts?.test) return "npm test";
  } catch {
    /* no package.json */
  }
  if (
    existsSync(join(cwd, "pytest.ini")) ||
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "setup.cfg"))
  ) {
    return "pytest";
  }
  return null;
}
