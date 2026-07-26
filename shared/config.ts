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
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

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
 * The Pi agent directory — **Pi's own resolution**, not a reimplementation of it.
 *
 * This used to be `process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`,
 * which is right for exactly one build of Pi. Both halves are configurable upstream:
 * `CONFIG_DIR_NAME` comes from Pi's `package.json` `piConfig.configDir`, and the env
 * var name is derived from `piConfig.name` — so a rebranded distribution reads
 * `TAU_CODING_AGENT_DIR` and `~/.tau/agent`, and the suite would have written its
 * config, memories, agent roster, and checkpoints into a `.pi` nobody else looks at.
 * The literal also skipped Pi's `expandTildePath`, so `PI_CODING_AGENT_DIR=~/x`
 * created a directory actually named `~`.
 *
 * Same argument as `cwdOf` and `exec`: one implementation, not a copy. The difference
 * is that here the one implementation already existed — it just lived upstream.
 */
export function agentDir(): string {
  return getAgentDir();
}

/**
 * A project-local Pi directory, e.g. `<cwd>/.pi/memory`.
 *
 * The only permitted way to name that directory. pi-memory and pi-spawn each spelled
 * `join(cwd, ".pi", …)` inline, which is the same portability bug as above and one a
 * source scan can forbid — see `test/boundaries.test.ts`.
 *
 * **Reading anything under here is a trust decision.** These are files a repository
 * ships, and both callers turn them into model input. Gate on `ctx.isProjectTrusted()`.
 */
export function projectConfigDir(cwd: string, ...segments: string[]): string {
  return join(cwd, CONFIG_DIR_NAME, ...segments);
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

/** The per-extension accessors {@link defineConfig} produces. */
export interface ConfigAccess<T> {
  configPath(): string;
  loadConfig(path?: string): T;
  saveConfig(cfg: T, path?: string): void;
}

/**
 * Bind a spec to its three accessors.
 *
 * Each extension wrote these out by hand — the same three one-line wrappers, seven
 * times, differing only in the type they closed over. They exist so call sites read as
 * `loadConfig()` rather than `sharedLoad(SPEC)`, which is worth keeping; writing them
 * out is not.
 */
export function defineConfig<T>(spec: ConfigSpec<T>): ConfigAccess<T> {
  return {
    configPath: () => configPath(spec.name),
    loadConfig: (path) => loadConfig(spec, path),
    saveConfig: (cfg, path) => saveConfig(spec, cfg, path),
  };
}
