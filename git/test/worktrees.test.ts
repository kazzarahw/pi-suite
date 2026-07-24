import { test, expect } from "bun:test";
import { createWorktree, removeWorktree } from "../src/worktrees.ts";
import type { Git } from "../src/git.ts";

/** A Git double exposing only the worktree verbs createWorktree/removeWorktree touch. */
function fakeGit(over: Partial<Git> = {}): Git {
  return {
    worktreeAdd: async () => "",
    worktreeList: async () => [],
    worktreeRemove: async () => {},
    ...over,
  } as unknown as Git;
}

test("createWorktree adds a linked worktree on the pi-git/worktrees/<name> branch", async () => {
  const calls: Array<{ branch: string; path: string }> = [];
  const git = fakeGit({
    worktreeAdd: async (branch: string, path: string) => {
      calls.push({ branch, path });
      return "";
    },
    worktreeList: async () => [{ path: "/base/job1", branch: "pi-git/worktrees/job1", head: "abc" }],
  });
  const wt = await createWorktree(git, "/base", "job1");
  expect(calls).toEqual([{ branch: "pi-git/worktrees/job1", path: "/base/job1" }]);
  expect(wt).toEqual({ path: "/base/job1", branch: "pi-git/worktrees/job1", head: "abc" });
});

test("createWorktree synthesizes a Worktree when it isn't found in the list", async () => {
  const wt = await createWorktree(fakeGit({ worktreeList: async () => [] }), "/base", "job2");
  expect(wt).toEqual({ path: "/base/job2", branch: "pi-git/worktrees/job2", head: "" });
});

test("removeWorktree delegates to git.worktreeRemove(path)", async () => {
  let removed: string | undefined;
  await removeWorktree(fakeGit({ worktreeRemove: async (p: string) => { removed = p; } }), "/base/job3");
  expect(removed).toBe("/base/job3");
});
