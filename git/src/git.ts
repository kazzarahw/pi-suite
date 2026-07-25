import type { ExecFn } from "../../shared/exec.ts";
import { SCRUBBED_GIT_ENV } from "./detect.ts";

/**
 * Git worktrees — pi-spawn's isolation seam.
 *
 * This module used to hold the checkpoint machinery too: `snapshotTree`,
 * `restoreTree`, `updateRef`/`readRef`/`listRefs`, and a temporary-index helper.
 * All of it is gone. Snapshotting through git's index has a work-tree boundary, and
 * a session rooted above a nested repository falls off it — `add -A` records the
 * inner repository as a gitlink and captures none of its contents, so a restore
 * reverted the outer file, left the inner one edited, and reported success. Content
 * now lives in `store.ts`, keyed by absolute path; `detect.ts` uses git read-only to
 * find what changed. Nothing here writes to a repository except the worktree calls.
 */

export interface Worktree {
  path: string;
  branch: string;
  head: string;
}

export interface Git {
  worktreeAdd(branch: string, path: string): Promise<string>;
  worktreeList(): Promise<Worktree[]>;
  worktreeRemove(path: string): Promise<void>;
}

/**
 * Build a Git facade over an injected exec, bound to a working directory.
 *
 * Every invocation goes out with {@link SCRUBBED_GIT_ENV} applied, so an inherited
 * `GIT_DIR` or `GIT_WORK_TREE` — which git exports to hooks and to anything it
 * spawns — cannot redirect a call at a different repository. Identity comes from
 * `cwd` alone. Applied here rather than per call site: one forgotten site is how
 * this bug class survives.
 */
export function createGit(exec: ExecFn, cwd: string): Git {
  const run = async (args: string[]): Promise<string> => {
    const { stdout, stderr, code } = await exec("git", args, { cwd, env: SCRUBBED_GIT_ENV });
    if (code !== 0) throw new Error(`[pi-git] git ${args[0]} failed (${code}): ${stderr.trim()}`);
    return stdout;
  };

  return {
    async worktreeAdd(branch, path) {
      await run(["worktree", "add", "-b", branch, path]);
      return path;
    },

    async worktreeList() {
      const out = await run(["worktree", "list", "--porcelain"]);
      const worktrees: Worktree[] = [];
      let cur: Partial<Worktree> = {};
      const flush = () => {
        if (cur.path) worktrees.push({ path: cur.path, branch: cur.branch ?? "", head: cur.head ?? "" });
        cur = {};
      };
      for (const line of out.split("\n")) {
        if (line.startsWith("worktree ")) {
          flush();
          cur.path = line.slice("worktree ".length).trim();
        } else if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length).trim();
        else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).trim();
      }
      flush();
      return worktrees;
    },

    async worktreeRemove(path) {
      await run(["worktree", "remove", "--force", path]);
    },
  };
}
