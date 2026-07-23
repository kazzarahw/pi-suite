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

test("writeMemory across scopes stays a single entry (dedup by name)", () => {
  writeMemory(mem({ scope: "global", body: "g" }), cwd);
  writeMemory(mem({ scope: "project", body: "p" }), cwd);
  const matches = listMemories(cwd).filter((m) => m.name === "n1");
  expect(matches).toHaveLength(1);
  expect(matches[0]!.scope).toBe("project");
});

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
