import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceFiles } from "../src/prewarm.ts";

/**
 * `listWorkspaceFiles` — the candidate list prewarm picks representative files from.
 *
 * `discoverWarmTargets` beside it was already covered because it is pure and injectable;
 * this half touches the filesystem and shells out to git, so it was not. It is the only
 * part of prewarm that can behave differently between a repository and a bare directory,
 * which is exactly the case worth pinning: a session opened somewhere that is not a git
 * checkout must still warm something rather than silently warming nothing.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pi-lens-workspace-"));
}

test("falls back to a shallow scan outside a git repository", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.py"), "a = 1\n");

  const files = listWorkspaceFiles(dir);
  expect(files).toContain(join(dir, "a.ts"));
  expect(files).toContain(join(dir, "b.py"));
});

test("the fallback also looks in src/", () => {
  // Two directories, deliberately: a shallow scan of the root alone misses the layout
  // most projects actually use, and an unbounded walk would stat a whole tree on startup.
  const dir = scratch();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.ts"), "export const m = 1;\n");

  expect(listWorkspaceFiles(dir)).toContain(join(dir, "src", "main.ts"));
});

test("the fallback returns absolute paths", () => {
  // The manager opens these directly; a relative path would resolve against the
  // extension host's directory rather than the project.
  const dir = scratch();
  writeFileSync(join(dir, "a.ts"), "");
  for (const file of listWorkspaceFiles(dir)) {
    expect(file.startsWith("/")).toBe(true);
  }
});

test("the fallback lists files only, not directories", () => {
  const dir = scratch();
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "a.ts"), "");

  expect(listWorkspaceFiles(dir)).not.toContain(join(dir, "node_modules"));
});

test("an empty directory yields an empty list rather than throwing", () => {
  expect(listWorkspaceFiles(scratch())).toEqual([]);
});

test("a directory that does not exist yields an empty list rather than throwing", () => {
  // Prewarm is best-effort and runs on session start; a throw here would surface as a
  // startup failure for something entirely optional.
  expect(listWorkspaceFiles(join(tmpdir(), "pi-lens-definitely-absent-dir"))).toEqual([]);
});

test("inside a git repository it uses the tracked-file listing", () => {
  const dir = scratch();
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "tracked.ts"), "export const t = 1;\n");
  writeFileSync(join(dir, "untracked.ts"), "export const u = 1;\n");
  Bun.spawnSync(["git", "add", "tracked.ts"], { cwd: dir });

  const files = listWorkspaceFiles(dir);
  expect(files).toContain(join(dir, "tracked.ts"));
  // `git ls-files` is the point: it skips ignored and untracked noise for free, which is
  // what keeps this cheap in a real checkout.
  expect(files).not.toContain(join(dir, "untracked.ts"));
});

test("an empty git repository falls through to the shallow scan", () => {
  // `git ls-files` succeeds with no output here. Treating that as the answer would warm
  // nothing at all in a freshly-initialised project.
  const dir = scratch();
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");

  expect(listWorkspaceFiles(dir)).toContain(join(dir, "a.ts"));
});
