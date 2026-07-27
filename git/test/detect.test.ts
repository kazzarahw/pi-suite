import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec } from "../../shared/exec.ts";
import { isRepo, dirtyPaths, headRefs, SCRUBBED_GIT_ENV } from "../src/detect.ts";

let dir: string;

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
};

const initRepo = (at: string): void => {
  git(at, "init", "-q");
  git(at, "config", "user.email", "t@example.com");
  git(at, "config", "user.name", "T");
};

const write = (base: string, rel: string, content: string): string => {
  const abs = join(base, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-detect-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- isRepo ----------------------------------------------------------------

test("isRepo is true inside a repository and false outside one", async () => {
  expect(await isRepo(defaultExec, dir)).toBe(false);
  initRepo(dir);
  expect(await isRepo(defaultExec, dir)).toBe(true);
});

test("isRepo does not throw on a directory that does not exist", async () => {
  expect(await isRepo(defaultExec, join(dir, "nope"))).toBe(false);
});

// --- dirtyPaths ------------------------------------------------------------

test("dirtyPaths reports modified, untracked, and deleted files as absolute paths", async () => {
  initRepo(dir);
  const modified = write(dir, "modified.txt", "v1");
  const deleted = write(dir, "deleted.txt", "gone soon");
  write(dir, "clean.txt", "unchanged");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");

  writeFileSync(modified, "v2", "utf8");
  rmSync(deleted);
  const untracked = write(dir, "untracked.txt", "new");

  expect((await dirtyPaths(defaultExec, dir)).sort()).toEqual([deleted, modified, untracked].sort());
});

test("dirtyPaths lists untracked files individually, not their directory", async () => {
  initRepo(dir);
  write(dir, "seed.txt", "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");

  const a = write(dir, "fresh/a.txt", "a");
  const b = write(dir, "fresh/deeper/b.txt", "b");

  expect((await dirtyPaths(defaultExec, dir)).sort()).toEqual([a, b].sort());
});

test("dirtyPaths ignores what .gitignore ignores", async () => {
  initRepo(dir);
  write(dir, ".gitignore", "ignored.txt\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  write(dir, "ignored.txt", "noise");
  const seen = write(dir, "seen.txt", "signal");

  expect(await dirtyPaths(defaultExec, dir)).toEqual([seen]);
});

test("dirtyPaths returns [] outside a repository rather than throwing", async () => {
  write(dir, "a.txt", "content");
  expect(await dirtyPaths(defaultExec, dir)).toEqual([]);
});

test("a rename yields both the old and the new path", async () => {
  initRepo(dir);
  const before = write(dir, "before.txt", "a stable body that git will match as a rename\n".repeat(4));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const after = join(dir, "after.txt");
  git(dir, "mv", "before.txt", "after.txt");

  const paths = await dirtyPaths(defaultExec, dir);
  expect(paths.sort()).toEqual([after, before].sort());
});

test("a path with a space or a quote in it survives parsing", async () => {
  initRepo(dir);
  write(dir, "seed.txt", "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const spaced = write(dir, "a file with spaces.txt", "x");
  const quoted = write(dir, 'quo"te.txt', "y");

  expect((await dirtyPaths(defaultExec, dir)).sort()).toEqual([quoted, spaced].sort());
});

test("dirtyPaths descends into a nested repository it would otherwise report as one entry", async () => {
  initRepo(dir);
  write(dir, "outer.txt", "outer");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");

  // A repository checked out inside another one. `git status -uall` refuses to descend
  // into it and emits the single entry `inner/`; without expansion, the inner file's
  // change would be invisible to the checkpoint.
  const inner = join(dir, "inner");
  mkdirSync(inner, { recursive: true });
  initRepo(inner);
  const innerFile = write(inner, "test.txt", "inner change");

  expect(await dirtyPaths(defaultExec, dir)).toContain(innerFile);
});

// --- The inherited git environment (OpenCode issue #22477) -----------------

test("SCRUBBED_GIT_ENV unsets every variable that can redirect a git call", () => {
  expect(Object.keys(SCRUBBED_GIT_ENV).sort()).toEqual([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]);
  expect(Object.values(SCRUBBED_GIT_ENV).every((v) => v === undefined)).toBe(true);
});

test("an inherited GIT_DIR and GIT_INDEX_FILE cannot redirect detection", async () => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-decoy-")));
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  try {
    initRepo(decoy);
    write(decoy, "decoy.txt", "decoy");
    git(decoy, "add", "-A");
    git(decoy, "commit", "-qm", "decoy base");
    const decoyIndex = join(decoy, ".git", "index");
    const indexBefore = readFileSync(decoyIndex);

    initRepo(dir);
    write(dir, "seed.txt", "seed");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const real = write(dir, "real.txt", "the file the session actually changed");

    // Pi is launched from a git hook, or from a shell where these are exported.
    process.env.GIT_DIR = join(decoy, ".git");
    process.env.GIT_WORK_TREE = decoy;
    process.env.GIT_INDEX_FILE = decoyIndex;

    expect(await isRepo(defaultExec, dir)).toBe(true);
    expect(await dirtyPaths(defaultExec, dir)).toEqual([real]);
    expect(readFileSync(decoyIndex).equals(indexBefore)).toBe(true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(decoy, { recursive: true, force: true });
  }
});

test("git really does honour the environment we are scrubbing", async () => {
  // Guards the guard: if git ever stopped reading GIT_DIR, the test above would pass
  // for the wrong reason and the scrub could be deleted without anything going red.
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-decoy2-")));
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-plain-")));
  const saved = process.env.GIT_DIR;
  try {
    initRepo(decoy);
    process.env.GIT_DIR = join(decoy, ".git");

    const inherited = await defaultExec("git", ["rev-parse", "--absolute-git-dir"], { cwd: plain });
    expect(inherited.stdout.trim()).toBe(join(decoy, ".git"));

    const scrubbed = await defaultExec("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: plain,
      env: SCRUBBED_GIT_ENV,
    });
    expect(scrubbed.code).not.toBe(0);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
    rmSync(plain, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

// --- HEAD ------------------------------------------------------------------
//
// pi-git restores files and never moves a ref. Recording where HEAD pointed is what
// lets a rewind explain the half it structurally cannot put back, instead of leaving
// the user with a tree that silently reverts its own history.

test("headRefs reports the repository root and its HEAD commit", async () => {
  initRepo(dir);
  write(dir, "a.txt", "one");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "first");

  const heads = await headRefs(defaultExec, dir);
  expect(Object.keys(heads)).toEqual([dir]);
  expect(heads[dir]).toMatch(/^[0-9a-f]{40}$/);

  const before = heads[dir];
  write(dir, "a.txt", "two");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "second");
  expect((await headRefs(defaultExec, dir))[dir]).not.toBe(before);
});

test("headRefs reports nothing outside a repository", async () => {
  expect(await headRefs(defaultExec, dir)).toEqual({});
});

test("headRefs reports nothing on a repository with no commits", async () => {
  // An unborn branch has no HEAD to record. `{}` says "nothing to compare", which is
  // what keeps a later restore from inventing a drift message out of an empty string.
  initRepo(dir);
  write(dir, "a.txt", "uncommitted");
  expect(await headRefs(defaultExec, dir)).toEqual({});
});
