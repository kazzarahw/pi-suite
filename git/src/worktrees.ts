import { join } from "node:path";
import type { Git, Worktree } from "./git.ts";

/** pi-spawn's isolation seam: a linked worktree on a fresh branch under baseDir. */
export async function createWorktree(git: Git, baseDir: string, name: string): Promise<Worktree> {
  const path = join(baseDir, name);
  const branch = `pi-git/worktrees/${name}`;
  await git.worktreeAdd(branch, path);
  const found = (await git.worktreeList()).find((w) => w.path === path);
  return found ?? { path, branch, head: "" };
}

export async function removeWorktree(git: Git, path: string): Promise<void> {
  await git.worktreeRemove(path);
}
