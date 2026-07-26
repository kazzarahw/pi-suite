import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExecFn } from "../../shared/exec.ts";

/**
 * Git as a **change detector**, never as storage.
 *
 * The checkpoint store (`store.ts`) owns file content. Git's remaining job is the one
 * it is genuinely good at: answering "what has changed since the last commit", which
 * is how a file altered by `bash` — never passing through the `write` or `edit` tool —
 * still gets checkpointed. Everything here is read-only: no index, no objects, no refs.
 */

/**
 * Environment variables that redirect a git invocation at a different repository.
 *
 * Git exports these to hooks and to anything it spawns, so a Pi started from a
 * `post-commit` hook — or from a shell where someone exported `GIT_DIR` — inherits
 * them, and every subsequent git call silently operates on the wrong repository.
 * OpenCode issue #22477 is this bug. Repository identity must come from `cwd` alone.
 *
 * Applied once, at this module's boundary, rather than at each call site: one
 * forgotten call is exactly how this class of bug survives.
 */
export const SCRUBBED_GIT_ENV: Readonly<Record<string, undefined>> = Object.freeze({
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_NAMESPACE: undefined,
});

/** Detection runs on a hook; it may not stall a turn waiting on a wedged git. */
export const DETECT_TIMEOUT_MS = 10_000;

/**
 * How far to descend into repositories nested inside the one being inspected.
 * Two levels covers the layout that motivated it — a session rooted at a directory
 * of checkouts — without turning detection into an unbounded filesystem walk.
 */
export const MAX_NESTED_DEPTH = 2;

export interface DetectOptions {
  signal?: AbortSignal;
  /** Remaining nesting levels; defaults to {@link MAX_NESTED_DEPTH}. */
  depth?: number;
}

const runGit = (exec: ExecFn, cwd: string, args: string[], signal?: AbortSignal) =>
  exec("git", args, { cwd, env: SCRUBBED_GIT_ENV, signal, timeout: DETECT_TIMEOUT_MS });

export async function isRepo(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<boolean> {
  const r = await runGit(exec, cwd, ["rev-parse", "--is-inside-work-tree"], signal);
  return r.code === 0 && r.stdout.trim() === "true";
}

/**
 * Every path git considers changed under `cwd`, absolute, so the result composes
 * directly with the store's key space. `[]` when `cwd` is not a repository — the
 * caller falls back to the paths it tracked through tool calls.
 */
/**
 * Every file git tracks under `cwd`, absolute. `[]` outside a repository.
 *
 * `dirtyPaths` answers "what changed"; this answers "what *could* change", and the
 * difference is the whole point of the delegation guard. pi-git normally learns a
 * file's pre-edit bytes from the `tool_call` hook, which fires in *this* process — so
 * a subagent, editing from its own `pi` process, is invisible to it. A file that was
 * clean when the delegation started and modified by it therefore has no recorded
 * origin, and a rewind past the delegation silently leaves it modified.
 *
 * There is no way to know in advance which files a subagent will touch, so the guard
 * records the ones it *can* touch. That is only affordable because the store is
 * content-addressed: a file checkpointed unchanged is one blob, shared across every
 * entry and session that references it.
 *
 * Tracked files only — not untracked ones, which `dirtyPaths` already covers, and not
 * ignored ones, which are build output.
 */
export async function trackedPaths(
  exec: ExecFn,
  cwd: string,
  opts: DetectOptions = {},
): Promise<string[]> {
  const { signal } = opts;
  if (!(await isRepo(exec, cwd, signal))) return [];
  // `-z` for the same reason as `status`: a path is only unambiguous NUL-terminated.
  const r = await runGit(exec, cwd, ["ls-files", "-z"], signal);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\0")
    .filter((p) => p.length > 0)
    .map((p) => resolve(cwd, p));
}

export async function dirtyPaths(
  exec: ExecFn,
  cwd: string,
  opts: DetectOptions = {},
): Promise<string[]> {
  const { signal, depth = MAX_NESTED_DEPTH } = opts;
  if (!(await isRepo(exec, cwd, signal))) return [];

  // `-z` because a path is only unambiguous when it is NUL-terminated: the default
  // format quotes and escapes anything unusual. `-uall` because the default lists an
  // untracked directory as one entry, and a directory is not something the store can
  // checkpoint.
  const r = await runGit(exec, cwd, ["status", "--porcelain", "-z", "-uall"], signal);
  if (r.code !== 0) return [];

  const found = new Set<string>();
  const records = r.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    found.add(resolve(cwd, record.slice(3)));
    // A rename or copy is followed by its source path in the next record. Recording
    // both makes the change restorable from either side.
    if (status.includes("R") || status.includes("C")) {
      const origin = records[++i];
      if (origin) found.add(resolve(cwd, origin));
    }
  }

  const out: string[] = [];
  for (const path of found) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      out.push(path); // a deleted file: no longer statable, and exactly what we want
      continue;
    }
    if (!isDirectory) {
      out.push(path);
      continue;
    }
    // Git reports a repository nested inside this one as a single directory entry and
    // refuses to look inside. Ask that repository about itself instead — otherwise a
    // change under it is invisible, which is the shape of the original half-restore.
    if (depth > 0 && existsSync(join(path, ".git"))) {
      out.push(...(await dirtyPaths(exec, path, { signal, depth: depth - 1 })));
    }
  }
  return out;
}
