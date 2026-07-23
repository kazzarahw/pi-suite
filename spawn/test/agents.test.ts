import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgent, discoverAgents, defaultAgents } from "../src/agents.ts";

test("parseAgent reads frontmatter + body", () => {
  const md = `---\nname: scout\ndescription: recon\nmodel: opus\ntools: read, grep\n---\nYou are Scout.\nBe terse.`;
  const a = parseAgent(md);
  expect(a).not.toBeNull();
  expect(a!.name).toBe("scout");
  expect(a!.description).toBe("recon");
  expect(a!.model).toBe("opus");
  expect(a!.tools).toEqual(["read", "grep"]);
  expect(a!.systemPrompt).toBe("You are Scout.\nBe terse.");
});

test("parseAgent returns null without frontmatter or a name", () => {
  expect(parseAgent("no frontmatter")).toBeNull();
  expect(parseAgent("---\ndescription: x\n---\nbody")).toBeNull();
});

test("parseAgent omits empty tools/model", () => {
  const a = parseAgent(`---\nname: worker\n---\nDo the thing.`);
  expect(a!.tools).toBeUndefined();
  expect(a!.model).toBeUndefined();
});

test("defaultAgents loads the bundled roster", () => {
  expect(defaultAgents().map((a) => a.name).sort()).toEqual(["reviewer", "scout", "worker"]);
});

test("discoverAgents lets a project agent override a default by name", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-spawn-disc-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", "scout.md"), `---\nname: scout\ndescription: MY scout\n---\ncustom`);

  const agents = discoverAgents(cwd);
  expect(agents.find((a) => a.name === "scout")!.description).toBe("MY scout");
  expect(agents.some((a) => a.name === "worker")).toBe(true);

  rmSync(cwd, { recursive: true, force: true });
});
