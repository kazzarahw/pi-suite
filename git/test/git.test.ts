import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit, defaultExec } from "../src/git.ts";

async function setupRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-git-test-"));
  const g = (args: string[]) => defaultExec("git", args, { cwd: dir });
  await g(["init", "-q"]);
  await g(["config", "user.email", "t@t.co"]);
  await g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "tracked.txt"), "original\n");
  await g(["add", "-A"]);
  await g(["commit", "-q", "-m", "init"]);
  return dir;
}

test("snapshotTree + restoreTree round-trips tracked/untracked/nested and removes post-snapshot files", async () => {
  const dir = await setupRepo();
  const git = createGit(defaultExec, dir);

  // Checkpoint-time state: modify a tracked file, add an untracked file, add a nested file.
  writeFileSync(join(dir, "tracked.txt"), "checkpoint content\n");
  writeFileSync(join(dir, "untracked.txt"), "i am untracked\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "nested.txt"), "nested content\n");
  const sha = await git.snapshotTree("test");
  expect(sha).toMatch(/^[0-9a-f]{40}$/);

  // Diverge after the checkpoint.
  writeFileSync(join(dir, "tracked.txt"), "LATER edit\n");
  writeFileSync(join(dir, "created-after.txt"), "should be removed on restore\n");
  rmSync(join(dir, "untracked.txt"));
  rmSync(join(dir, "sub"), { recursive: true });

  await git.restoreTree(sha);

  expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("checkpoint content\n");
  expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("i am untracked\n");
  expect(readFileSync(join(dir, "sub", "nested.txt"), "utf8")).toBe("nested content\n");
  expect(existsSync(join(dir, "created-after.txt"))).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});

test("snapshotTree honors .gitignore and leaves the real index untouched", async () => {
  const dir = await setupRepo();
  const git = createGit(defaultExec, dir);
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "ignored.txt"), "build artifact\n");

  const sha = await git.snapshotTree("test");
  const filesInSnapshot = (await defaultExec("git", ["ls-tree", "-r", "--name-only", sha], { cwd: dir })).stdout;
  expect(filesInSnapshot).not.toContain("ignored.txt");

  const staged = (await defaultExec("git", ["diff", "--cached", "--name-only"], { cwd: dir })).stdout;
  expect(staged.trim()).toBe("");

  rmSync(dir, { recursive: true, force: true });
});

test("updateRef / readRef / listRefs work on the private namespace", async () => {
  const dir = await setupRepo();
  const git = createGit(defaultExec, dir);
  const sha = await git.snapshotTree("x");

  await git.updateRef("refs/pi-git/checkpoints/abc123", sha);
  expect(await git.readRef("refs/pi-git/checkpoints/abc123")).toBe(sha);
  expect(await git.readRef("refs/pi-git/checkpoints/missing")).toBeNull();
  expect(await git.listRefs("refs/pi-git/checkpoints/")).toEqual([
    { ref: "refs/pi-git/checkpoints/abc123", sha },
  ]);

  rmSync(dir, { recursive: true, force: true });
});

test("worktreeAdd / worktreeList / worktreeRemove lifecycle", async () => {
  const dir = await setupRepo();
  const git = createGit(defaultExec, dir);
  const wtPath = join(dir, "..", `wt-${Date.now()}`);

  await git.worktreeAdd("pi-spawn/job1", wtPath);
  const list = await git.worktreeList();
  expect(list.some((w) => w.path === wtPath || w.branch.includes("pi-spawn/job1"))).toBe(true);

  await git.worktreeRemove(wtPath);
  expect(existsSync(wtPath)).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});
