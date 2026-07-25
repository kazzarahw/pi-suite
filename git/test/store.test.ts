import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, DEFAULT_MAX_FILE_BYTES } from "../src/store.ts";

/**
 * The checkpoint store is the fix for the silent half-restore.
 *
 * pi-git used to snapshot with git plumbing: `git add -A` into a temporary index,
 * `write-tree`, `commit-tree`. With the session rooted at a directory that *contains*
 * another repository, `add -A` records the inner repository as a gitlink (mode 160000)
 * and captures none of its contents — so a restore reverted the outer file, left the
 * inner one edited, and reported success.
 *
 * This store keys on absolute paths. A path has no root, so it has no work-tree
 * boundary, so a nested repository is not a special case. These tests hold that line.
 */

let root: string; // the store's own directory
let proj: string; // a project being checkpointed

beforeEach(() => {
  // realpath so the test's own paths match the store's normalised keys on platforms
  // where the temp directory is itself a symlink (macOS /var -> /private/var).
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-store-")));
  proj = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-proj-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

const store = (sessionId = "s1", opts: Record<string, unknown> = {}) =>
  createStore(sessionId, { root, ...opts });

const write = (rel: string, content: string): string => {
  const abs = join(proj, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
};

const read = (abs: string): string => readFileSync(abs, "utf8");

// --- Round trip ------------------------------------------------------------

test("checkpoint, modify, restore returns the original bytes", async () => {
  const s = store();
  const f = write("a.txt", "original");
  await s.checkpoint("e1", [f]);

  writeFileSync(f, "modified", "utf8");
  const result = await s.restore("e1");

  expect(read(f)).toBe("original");
  expect(result.written).toEqual([f]);
});

test("restore is a no-op for a file that already matches the checkpoint", async () => {
  const s = store();
  const f = write("a.txt", "same");
  await s.checkpoint("e1", [f]);
  const before = statSync(f).mtimeMs;

  const result = await s.restore("e1");

  expect(result.written).toEqual([]);
  expect(statSync(f).mtimeMs).toBe(before);
});

test("restore of an unknown entry changes nothing", async () => {
  const s = store();
  const f = write("a.txt", "v1");
  await s.checkpoint("e1", [f]);
  writeFileSync(f, "v2", "utf8");

  expect(await s.has("nope")).toBe(false);
  const result = await s.restore("nope");

  expect(result).toEqual({ written: [], removed: [] });
  expect(read(f)).toBe("v2");
});

// --- Origins: what "before" means for a path first seen mid-session ---------

test("a file created after an entry is deleted when restoring to that entry", async () => {
  const s = store();
  const kept = write("kept.txt", "kept");
  await s.checkpoint("e1", [kept]);

  // The agent creates a file in the next turn. tool_call records its origin first —
  // absent — which is what makes the deletion safe.
  const made = join(proj, "made.txt");
  await s.rememberOrigin(made);
  writeFileSync(made, "new file", "utf8");
  await s.checkpoint("e2", [kept, made]);

  const result = await s.restore("e1");

  expect(existsSync(made)).toBe(false);
  expect(result.removed).toEqual([made]);
  expect(read(kept)).toBe("kept");
});

test("a file that existed before pi-git saw it restores to its origin, not deletion", async () => {
  const s = store();
  const early = write("early.txt", "pre-existing");
  const other = write("other.txt", "x");
  await s.checkpoint("e1", [other]); // `early` is not tracked yet

  writeFileSync(early, "edited", "utf8");
  await s.rememberOrigin(early); // too late to see the original — records "edited"
  await s.checkpoint("e2", [other, early]);

  writeFileSync(early, "edited again", "utf8");
  await s.restore("e1");

  // e1 has no record of `early`, so it falls back to the origin. Never deleted:
  // the store has no evidence the file was ever absent.
  expect(existsSync(early)).toBe(true);
  expect(read(early)).toBe("edited");
});

test("rememberOrigin never overwrites an origin it already holds", async () => {
  const s = store();
  const f = write("a.txt", "first");
  await s.rememberOrigin(f);
  writeFileSync(f, "second", "utf8");
  await s.rememberOrigin(f); // must not replace "first"

  const anchor = write("anchor.txt", "anchor");
  await s.checkpoint("e1", [anchor]); // e1 holds no record of `f`
  writeFileSync(f, "third", "utf8");

  await s.restore("e1");
  expect(read(f)).toBe("first"); // the origin, not the second sighting
});

test("tracked() is every path the store has an origin for", async () => {
  const s = store();
  const a = write("a.txt", "a");
  const b = write("b.txt", "b");
  await s.rememberOrigin(a);
  await s.checkpoint("e1", [b]);
  expect([...s.tracked()].sort()).toEqual([a, b].sort());
});

test("origins survive a fresh store over the same session directory", async () => {
  const gone = join(proj, "gone.txt");
  await store().rememberOrigin(gone);
  writeFileSync(gone, "created", "utf8");
  await store().checkpoint("e1", [gone]);

  // A second process (or a re-import) must see the same origins.
  expect(store().tracked()).toEqual([gone]);
});

// --- The nested-repository case: the reason this store exists ---------------

test("two files under different repositories both restore", async () => {
  const s = store();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });

  // Outer repository with an inner repository inside it — the layout that made
  // `git add -A` record a gitlink and silently skip the inner file.
  git(proj, "init", "-q");
  const inner = join(proj, "inner");
  mkdirSync(inner, { recursive: true });
  git(inner, "init", "-q");

  const outerFile = write("test.txt", "outer v1");
  const innerFile = write("inner/test.txt", "inner v1");
  await s.checkpoint("e1", [outerFile, innerFile]);

  writeFileSync(outerFile, "outer v2", "utf8");
  writeFileSync(innerFile, "inner v2", "utf8");
  await s.restore("e1");

  expect(read(outerFile)).toBe("outer v1");
  expect(read(innerFile)).toBe("inner v1"); // the half-restore that started this
});

test("paths in unrelated directory trees restore together", async () => {
  const s = store();
  const away = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-away-")));
  try {
    const here = write("here.txt", "here v1");
    const there = join(away, "there.txt");
    writeFileSync(there, "there v1", "utf8");

    await s.checkpoint("e1", [here, there]);
    writeFileSync(here, "here v2", "utf8");
    writeFileSync(there, "there v2", "utf8");
    await s.restore("e1");

    expect(read(here)).toBe("here v1");
    expect(read(there)).toBe("there v1");
  } finally {
    rmSync(away, { recursive: true, force: true });
  }
});

// --- Storage shape ---------------------------------------------------------

test("identical content in two checkpoints is stored as one blob", async () => {
  const s = store();
  const a = write("a.txt", "same bytes");
  const b = write("b.txt", "same bytes");
  await s.checkpoint("e1", [a, b]);

  expect(readdirSync(join(root, "blobs"))).toHaveLength(1);
});

test("a blob is shared across sessions", async () => {
  const f = write("a.txt", "shared");
  await store("s1").checkpoint("e1", [f]);
  await store("s2").checkpoint("e1", [f]);
  expect(readdirSync(join(root, "blobs"))).toHaveLength(1);
});

test("checkpointing writes nothing into the project tree", async () => {
  const s = store();
  const f = write("a.txt", "x");
  const before = readdirSync(proj).sort();
  await s.rememberOrigin(f);
  await s.checkpoint("e1", [f]);
  expect(readdirSync(proj).sort()).toEqual(before);
});

// --- Restore hygiene -------------------------------------------------------

test("restore removes directories its own deletions emptied", async () => {
  const s = store();
  const anchor = write("anchor.txt", "anchor");
  await s.checkpoint("e1", [anchor]);

  const nested = join(proj, "deep", "nest", "file.txt");
  await s.rememberOrigin(nested);
  mkdirSync(join(proj, "deep", "nest"), { recursive: true });
  writeFileSync(nested, "new", "utf8");
  await s.checkpoint("e2", [anchor, nested]);

  await s.restore("e1");

  expect(existsSync(join(proj, "deep"))).toBe(false);
});

test("restore keeps a directory that still holds something else", async () => {
  const s = store();
  const anchor = write("anchor.txt", "anchor");
  await s.checkpoint("e1", [anchor]);

  const made = join(proj, "shared", "made.txt");
  await s.rememberOrigin(made); // absent
  mkdirSync(join(proj, "shared"), { recursive: true });
  writeFileSync(made, "new", "utf8");
  writeFileSync(join(proj, "shared", "bystander.txt"), "not ours", "utf8");
  await s.checkpoint("e2", [anchor, made]);

  await s.restore("e1");

  expect(existsSync(made)).toBe(false);
  expect(existsSync(join(proj, "shared", "bystander.txt"))).toBe(true);
});

test("restore recreates parent directories for a file it must write back", async () => {
  const s = store();
  const f = write("a/b/c.txt", "content");
  await s.checkpoint("e1", [f]);
  rmSync(join(proj, "a"), { recursive: true, force: true });

  await s.restore("e1");
  expect(read(f)).toBe("content");
});

test("restore preserves the executable bit", async () => {
  const s = store();
  const f = write("run.sh", "#!/bin/sh\necho hi\n");
  execFileSync("chmod", ["+x", f]);
  await s.checkpoint("e1", [f]);

  writeFileSync(f, "changed", "utf8");
  execFileSync("chmod", ["-x", f]);
  await s.restore("e1");

  expect(statSync(f).mode & 0o111).toBeGreaterThan(0);
});

// --- Things the store refuses to touch -------------------------------------

test("a file over maxFileBytes is skipped and named, not silently dropped", async () => {
  const skipped: Array<{ path: string; bytes: number }> = [];
  const s = store("s1", { maxFileBytes: 16, onSkip: (path: string, bytes: number) => skipped.push({ path, bytes }) });
  const big = write("big.bin", "x".repeat(64));
  const small = write("small.txt", "ok");

  const manifest = await s.checkpoint("e1", [big, small]);

  expect(Object.keys(manifest)).toEqual([small]);
  expect(skipped).toEqual([{ path: big, bytes: 64 }]);
  // Crucially it is NOT recorded as absent — a restore must never delete it.
  expect(s.tracked()).not.toContain(big);

  writeFileSync(big, "y".repeat(64), "utf8");
  await s.restore("e1");
  expect(existsSync(big)).toBe(true);
});

test("the default size cap is 10 MB", () => {
  expect(DEFAULT_MAX_FILE_BYTES).toBe(10_485_760);
});

test("editing through a symlink protects the file it points at", async () => {
  const s = store();
  const target = write("target.txt", "v1");
  const link = join(proj, "link.txt");
  symlinkSync(target, link);

  // Pi's edit tool follows symlinks, so the path it reports may be the link. Keys are
  // normalised through realpath: the store protects the real file and never rewrites
  // the link itself into a regular file.
  await s.checkpoint("e1", [link]);
  expect(s.tracked()).toEqual([target]);

  writeFileSync(link, "v2", "utf8");
  await s.restore("e1");

  expect(read(target)).toBe("v1");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

test("a broken symlink is skipped rather than resurrected as a file", async () => {
  const s = store();
  const link = join(proj, "dangling.txt");
  symlinkSync(join(proj, "does-not-exist"), link);

  await s.checkpoint("e1", [link]);
  expect(s.tracked()).toEqual([]);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

test("a directory passed as a path is ignored", async () => {
  const s = store();
  const dir = join(proj, "adir");
  mkdirSync(dir);
  await s.checkpoint("e1", [dir]);
  expect(s.tracked()).not.toContain(dir);
  expect(existsSync(dir)).toBe(true);
});

// --- Garbage collection ----------------------------------------------------

const DAY = 86_400_000;

test("gc prunes sessions past the TTL and the blobs only they referenced", async () => {
  const old = store("old-session");
  const oldFile = write("old.txt", "old-only content");
  await old.checkpoint("e1", [oldFile]);

  const live = store("live-session");
  const liveFile = write("live.txt", "live content");
  await live.checkpoint("e1", [liveFile]);

  // Age the old session's files 60 days into the past.
  const past = new Date(Date.now() - 60 * DAY);
  const oldDir = join(root, "old-session");
  for (const f of readdirSync(oldDir)) utimesSync(join(oldDir, f), past, past);
  utimesSync(oldDir, past, past);

  const result = await live.gc(30, Date.now());

  expect(result.sessions).toBe(1);
  expect(result.blobs).toBe(1);
  expect(existsSync(oldDir)).toBe(false);
  expect(existsSync(join(root, "live-session"))).toBe(true);
  // The live session can still restore.
  writeFileSync(liveFile, "changed", "utf8");
  await live.restore("e1");
  expect(read(liveFile)).toBe("live content");
});

test("gc keeps a blob an old session shared with a live one", async () => {
  const shared = write("shared.txt", "shared bytes");
  const old = store("old-session");
  await old.checkpoint("e1", [shared]);
  const live = store("live-session");
  await live.checkpoint("e1", [shared]);

  const past = new Date(Date.now() - 60 * DAY);
  const oldDir = join(root, "old-session");
  for (const f of readdirSync(oldDir)) utimesSync(join(oldDir, f), past, past);
  utimesSync(oldDir, past, past);

  await live.gc(30, Date.now());
  expect(readdirSync(join(root, "blobs"))).toHaveLength(1);
});

test("gc never prunes its own session, however stale the directory looks", async () => {
  const s = store("current");
  const f = write("a.txt", "content");
  await s.checkpoint("e1", [f]);

  const past = new Date(Date.now() - 900 * DAY);
  const dir = join(root, "current");
  for (const n of readdirSync(dir)) utimesSync(join(dir, n), past, past);
  utimesSync(dir, past, past);

  const result = await s.gc(30, Date.now());
  expect(result.sessions).toBe(0);
  expect(existsSync(dir)).toBe(true);
});

test("gc on an empty store is a no-op", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-git-empty-"));
  try {
    const s = createStore("s1", { root: join(empty, "nothing-here") });
    expect(await s.gc(30, Date.now())).toEqual({ sessions: 0, blobs: 0 });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("gc run twice in a row is idempotent", async () => {
  const old = store("old-session");
  await old.checkpoint("e1", [write("a.txt", "content")]);
  const past = new Date(Date.now() - 60 * DAY);
  const dir = join(root, "old-session");
  for (const n of readdirSync(dir)) utimesSync(join(dir, n), past, past);
  utimesSync(dir, past, past);

  const live = store("live-session");
  expect(await live.gc(30, Date.now())).toEqual({ sessions: 1, blobs: 1 });
  expect(await live.gc(30, Date.now())).toEqual({ sessions: 0, blobs: 0 });
});

test("a restore whose blob was collected leaves the file alone rather than truncating it", async () => {
  const s = store();
  const f = write("a.txt", "v1");
  await s.checkpoint("e1", [f]);
  rmSync(join(root, "blobs"), { recursive: true, force: true });

  writeFileSync(f, "v2", "utf8");
  const result = await s.restore("e1");

  expect(read(f)).toBe("v2");
  expect(result.written).toEqual([]);
});
