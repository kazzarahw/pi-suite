import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemories, readMemory, writeMemory, deleteMemory } from "../src/store.ts";
import type { Memory } from "../src/frontmatter.ts";

let globalDir: string;
let cwd: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.PI_CODING_AGENT_DIR;
  globalDir = mkdtempSync(join(tmpdir(), "pi-mem-g-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-mem-p-"));
  process.env.PI_CODING_AGENT_DIR = globalDir;
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
