/**
 * The suite's config mechanism.
 *
 * Splits what were seven near-identical modules along a **mechanism / policy**
 * seam: path resolution, reading, writing, and the corrupt-file fallback live
 * here; field validation stays with each extension, because the shapes genuinely
 * differ (pi-lens's `verifyCmd`/`autoFormat`/`prewarm` has nothing in common with
 * pi-git's nested `worktrees`).
 *
 * Each extension exports a {@link ConfigSpec} and thin `loadConfig`/`saveConfig`
 * wrappers, so its call sites stay unchanged.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ConfigSpec<T> {
  /** Short extension name; `"lens"` resolves to `<agentDir>/pi-lens.json`. */
  name: string;
  /** Values used when the file is missing, unreadable, or malformed. */
  defaults: T;
  /**
   * Validate raw parsed JSON into a complete config. Called only with a
   * successfully-parsed value; must not throw (a throw is treated as corrupt
   * and falls back to `defaults`).
   */
  parse(raw: unknown, defaults: T): T;
}

/**
 * The Pi agent directory. Honors `PI_CODING_AGENT_DIR` — previously only pi-lens
 * and pi-memory did, which meant a custom agent dir split the suite's config in
 * half. Unifying here fixes that for all seven (spec D5).
 */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configPath(name: string): string {
  return join(agentDir(), `pi-${name}.json`);
}

/** Read a config. Never throws: any failure yields a copy of `spec.defaults`. */
export function loadConfig<T>(spec: ConfigSpec<T>, path: string = configPath(spec.name)): T {
  try {
    return spec.parse(JSON.parse(readFileSync(path, "utf8")), spec.defaults);
  } catch {
    return structuredClone(spec.defaults);
  }
}

/** Write a config, creating the parent directory if needed. */
export function saveConfig<T>(
  spec: ConfigSpec<T>,
  cfg: T,
  path: string = configPath(spec.name),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
