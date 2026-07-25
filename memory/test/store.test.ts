import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMemories,
  readMemory,
  writeMemory,
  deleteMemory,
  invalidateIndexCache,
  memoryDirs,
} from "../src/store.ts";
import type { Memory } from "../src/frontmatter.ts";

let globalDir: string;
let cwd: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.PI_CODING_AGENT_DIR;
  globalDir = mkdtempSync(join(tmpdir(), "pi-mem-g-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-mem-p-"));
  process.env.PI_CODING_AGENT_DIR = globalDir;
  invalidateIndexCache();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevEnv;
  rmSync(globalDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const mem = (over: Partial<Memory> = {}): Memory => ({
  name: "n1",
  description: "d1",
  type: "reference",
  scope: "global",
  body: "b1",
  ...over,
});

test("writeMemory persists; readMemory reads it back", () => {
  writeMemory(mem(), cwd);
  expect(readMemory("n1", cwd)?.body).toBe("b1");
});

test("writeMemory dedups by name (updates in place, single entry)", () => {
  writeMemory(mem({ body: "old" }), cwd);
  writeMemory(mem({ body: "new" }), cwd);
  const matches = listMemories(cwd).filter((m) => m.name === "n1");
  expect(matches).toHaveLength(1);
  expect(matches[0]!.body).toBe("new");
});

// A test asserting cross-scope dedup ("stays a single entry") was removed here: it
// encoded the data-loss defect as intended behavior, which is why the defect survived
// a green suite. Its replacement — that both scopes' copies survive — is in the
// "Scope isolation" section below.

test("listMemories merges global + project and tags scope", () => {
  writeMemory(mem({ name: "g", scope: "global" }), cwd);
  writeMemory(mem({ name: "p", scope: "project" }), cwd);
  expect(listMemories(cwd).map((m) => m.name).sort()).toEqual(["g", "p"]);
  expect(listMemories(cwd).find((m) => m.name === "p")!.scope).toBe("project");
});

test("deleteMemory removes it", () => {
  writeMemory(mem(), cwd);
  deleteMemory("n1", cwd);
  expect(readMemory("n1", cwd)).toBeNull();
});

// --- Scope isolation -------------------------------------------------------
// writeMemory documented itself as "deduping by name across scopes" and called
// deleteMemory, which swept BOTH directories. Writing a project memory therefore
// destroyed a same-named global one with no warning. Names are scoped; a project
// note called "build-cmd" is a different fact from a global one.

test("writing a project memory leaves a same-named global memory intact", () => {
  writeMemory(mem({ name: "build-cmd", scope: "global", body: "global body" }), cwd);
  writeMemory(mem({ name: "build-cmd", scope: "project", body: "project body" }), cwd);

  const both = listMemories(cwd).filter((m) => m.name === "build-cmd");
  expect(both).toHaveLength(2);
  expect(both.find((m) => m.scope === "global")?.body).toBe("global body");
  expect(both.find((m) => m.scope === "project")?.body).toBe("project body");
});

test("writing a global memory leaves a same-named project memory intact", () => {
  writeMemory(mem({ name: "notes", scope: "project", body: "project body" }), cwd);
  writeMemory(mem({ name: "notes", scope: "global", body: "global body" }), cwd);
  expect(listMemories(cwd).filter((m) => m.name === "notes")).toHaveLength(2);
});

test("rewriting within one scope still replaces in place", () => {
  writeMemory(mem({ name: "x", scope: "project", body: "old" }), cwd);
  writeMemory(mem({ name: "x", scope: "project", body: "new" }), cwd);
  const matches = listMemories(cwd).filter((m) => m.name === "x");
  expect(matches).toHaveLength(1);
  expect(matches[0]!.body).toBe("new");
});

test("deleteMemory without a scope removes the name from both scopes", () => {
  // An explicit user deletion naming a memory should mean exactly that.
  writeMemory(mem({ name: "gone", scope: "global" }), cwd);
  writeMemory(mem({ name: "gone", scope: "project" }), cwd);
  deleteMemory("gone", cwd);
  expect(listMemories(cwd).filter((m) => m.name === "gone")).toHaveLength(0);
});

test("deleteMemory with a scope removes only that scope's copy", () => {
  writeMemory(mem({ name: "keep", scope: "global", body: "g" }), cwd);
  writeMemory(mem({ name: "keep", scope: "project", body: "p" }), cwd);
  deleteMemory("keep", cwd, "project");
  const left = listMemories(cwd).filter((m) => m.name === "keep");
  expect(left).toHaveLength(1);
  expect(left[0]!.scope).toBe("global");
});

// --- Index cache -----------------------------------------------------------
// `listMemories` runs on the `context` hook, i.e. before every LLM call, and used to
// re-read and re-parse every memory file each time. The cache turns that into a
// directory listing plus one `stat` per file.
//
// Revalidation is per *file* mtime+size, not the directory's mtime: a directory's
// mtime changes only when an entry is added or removed, so editing a memory in place
// — with $EDITOR, or by another Pi session — would never be noticed.

test("a repeated listMemories with nothing changed does not re-read the files", () => {
  writeMemory(mem({ name: "cached", scope: "global" }), cwd);
  const first = listMemories(cwd);
  const second = listMemories(cwd);
  // Same array instance: proof it came from the cache rather than a fresh parse.
  expect(second).toBe(first);
});

test("writing through the store invalidates the cache", () => {
  writeMemory(mem({ name: "v", scope: "global", body: "old" }), cwd);
  expect(listMemories(cwd).find((m) => m.name === "v")!.body).toBe("old");
  writeMemory(mem({ name: "v", scope: "global", body: "new" }), cwd);
  expect(listMemories(cwd).find((m) => m.name === "v")!.body).toBe("new");
});

test("deleting through the store invalidates the cache", () => {
  writeMemory(mem({ name: "d", scope: "project" }), cwd);
  expect(listMemories(cwd)).toHaveLength(1);
  deleteMemory("d", cwd);
  expect(listMemories(cwd)).toHaveLength(0);
});

test("an edit made outside the store busts the cache", () => {
  writeMemory(mem({ name: "external", scope: "project", body: "before" }), cwd);
  expect(listMemories(cwd).find((m) => m.name === "external")!.body).toBe("before");

  // Simulate another process (or $EDITOR) rewriting the file: no invalidate call.
  const file = join(memoryDirs(cwd).project, "external.md");
  writeFileSync(
    file,
    "---\nname: external\ndescription: d1\nmetadata:\n  type: reference\n---\n\nafter\n",
    "utf8",
  );
  const future = new Date(Date.now() + 5_000);
  utimesSync(file, future, future);

  expect(listMemories(cwd).find((m) => m.name === "external")!.body).toBe("after");
});

test("a file appearing outside the store busts the cache", () => {
  writeMemory(mem({ name: "first", scope: "project" }), cwd);
  expect(listMemories(cwd)).toHaveLength(1);

  const dir = memoryDirs(cwd).project;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "dropped-in.md"),
    "---\nname: dropped-in\ndescription: d\nmetadata:\n  type: reference\n---\n\nbody\n",
    "utf8",
  );

  expect(listMemories(cwd).map((m) => m.name).sort()).toEqual(["dropped-in", "first"]);
});

test("two projects do not share a cache entry", () => {
  const other = mkdtempSync(join(tmpdir(), "pi-mem-p2-"));
  try {
    writeMemory(mem({ name: "here", scope: "project" }), cwd);
    writeMemory(mem({ name: "there", scope: "project" }), other);
    expect(listMemories(cwd).map((m) => m.name)).toEqual(["here"]);
    expect(listMemories(other).map((m) => m.name)).toEqual(["there"]);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("invalidateIndexCache() with no argument clears every project", () => {
  writeMemory(mem({ name: "z", scope: "project" }), cwd);
  const first = listMemories(cwd);
  invalidateIndexCache();
  expect(listMemories(cwd)).not.toBe(first);
  expect(listMemories(cwd).map((m) => m.name)).toEqual(["z"]);
});
