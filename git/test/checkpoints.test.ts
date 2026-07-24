import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit, defaultExec } from "../src/git.ts";
import {
  checkpoint,
  checkpointRef,
  currentUserEntryId,
  findCheckpoint,
  restoreTo,
} from "../src/checkpoints.ts";

test("currentUserEntryId returns the leaf when it is a user message", () => {
  const sm = {
    getLeafEntry: () => ({ type: "message", id: "u2", message: { role: "user" } }),
    getBranch: () => [],
  };
  expect(currentUserEntryId(sm)).toBe("u2");
});

test("currentUserEntryId falls back to the last user message in the branch", () => {
  const sm = {
    getLeafEntry: () => ({ type: "message", id: "a9", message: { role: "assistant" } }),
    getBranch: () => [
      { type: "message", id: "u1", message: { role: "user" } },
      { type: "message", id: "a1", message: { role: "assistant" } },
      { type: "custom", id: "c1" },
    ],
  };
  expect(currentUserEntryId(sm)).toBe("u1");
});

test("currentUserEntryId is null when there is no user message", () => {
  expect(currentUserEntryId({ getLeafEntry: () => undefined, getBranch: () => [] })).toBeNull();
});

async function setupRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-git-cp-"));
  const g = (args: string[]) => defaultExec("git", args, { cwd: dir });
  await g(["init", "-q"]);
  await g(["config", "user.email", "t@t.co"]);
  await g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "f.txt"), "base\n");
  await g(["add", "-A"]);
  await g(["commit", "-q", "-m", "init"]);
  return dir;
}

test("checkpoint stores under the entry ref; findCheckpoint + restoreTo round-trip", async () => {
  const dir = await setupRepo();
  const git = createGit(defaultExec, dir);

  writeFileSync(join(dir, "f.txt"), "at checkpoint\n");
  const cp = await checkpoint(git, "u123", "turn", "2026-07-23T00:00:00Z");
  expect(cp.ref).toBe(checkpointRef("u123"));
  expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);

  const found = await findCheckpoint(git, "u123");
  expect(found?.sha).toBe(cp.sha);
  expect(await findCheckpoint(git, "nope")).toBeNull();

  writeFileSync(join(dir, "f.txt"), "changed later\n");
  await restoreTo(git, found!);
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("at checkpoint\n");

  rmSync(dir, { recursive: true, force: true });
});
