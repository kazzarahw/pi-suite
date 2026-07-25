import type { ExecFn } from "../../shared/exec.ts";
import { SCRUBBED_GIT_ENV } from "./detect.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


export interface Worktree {
  path: string;
  branch: string;
  head: string;
}

export interface Git {
  isRepo(): Promise<boolean>;
  /** Capture the whole working tree (tracked + untracked, honoring .gitignore) as a commit sha. */
  snapshotTree(reason: string): Promise<string>;
  /** Make the working tree exactly match the snapshot commit's tree (restores + removes extras). */
  restoreTree(sha: string): Promise<void>;
  isDirty(): Promise<boolean>;
  updateRef(ref: string, sha: string): Promise<void>;
  readRef(ref: string): Promise<string | null>;
  listRefs(prefix: string): Promise<Array<{ ref: string; sha: string }>>;
  worktreeAdd(branch: string, path: string): Promise<string>;
  worktreeList(): Promise<Worktree[]>;
  worktreeRemove(path: string): Promise<void>;
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Build a Git facade over an injected exec, bound to a working directory.
 *
 * Every invocation goes out with {@link SCRUBBED_GIT_ENV} applied, so an inherited
 * `GIT_DIR` or `GIT_INDEX_FILE` — which git exports to hooks and to anything it
 * spawns — cannot redirect a call at a different repository. Identity comes from
 * `cwd` alone. Applied here rather than per call site: one forgotten site is how
 * this bug class survives.
 */
export function createGit(exec: ExecFn, cwd: string): Git {
  const run = async (args: string[], env?: Record<string, string>): Promise<string> => {
    const { stdout, stderr, code } = await exec("git", args, {
      cwd,
      env: { ...SCRUBBED_GIT_ENV, ...env },
    });
    if (code !== 0) throw new Error(`[pi-git] git ${args[0]} failed (${code}): ${stderr.trim()}`);
    return stdout;
  };

  const withTempIndex = async <T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-"));
    try {
      return await fn({ GIT_INDEX_FILE: join(dir, "index") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    async isRepo() {
      const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, env: SCRUBBED_GIT_ENV });
      return r.code === 0 && r.stdout.trim() === "true";
    },

    async snapshotTree(reason) {
      return withTempIndex(async (env) => {
        await run(["add", "-A"], env);
        const tree = (await run(["write-tree"], env)).trim();
        const head = await exec("git", ["rev-parse", "HEAD"], { cwd, env: SCRUBBED_GIT_ENV });
        const parent = head.code === 0 ? ["-p", head.stdout.trim()] : [];
        return (await run(["commit-tree", tree, ...parent, "-m", `pi-git checkpoint: ${reason}`])).trim();
      });
    },

    async restoreTree(sha) {
      const snapshot = new Set(lines(await run(["ls-tree", "-r", "--name-only", sha])));
      await withTempIndex(async (env) => {
        await run(["read-tree", sha], env);
        await run(["checkout-index", "-a", "-f"], env);
      });
      // Remove files that exist now but were not in the snapshot (created after the checkpoint).
      const current = new Set([
        ...lines(await run(["ls-files"])),
        ...lines(await run(["ls-files", "--others", "--exclude-standard"])),
      ]);
      for (const file of current) {
        if (!snapshot.has(file)) rmSync(join(cwd, file), { force: true });
      }
    },

    async isDirty() {
      return (await run(["status", "--porcelain"])).trim().length > 0;
    },

    async updateRef(ref, sha) {
      await run(["update-ref", ref, sha]);
    },

    async readRef(ref) {
      const r = await exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, env: SCRUBBED_GIT_ENV });
      const sha = r.stdout.trim();
      return r.code === 0 && sha.length > 0 ? sha : null;
    },

    async listRefs(prefix) {
      const out = await run(["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
      return lines(out).map((line) => {
        const [ref, sha] = line.split(" ");
        return { ref: ref ?? "", sha: sha ?? "" };
      });
    },

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
