import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRecallTool, buildWriteTool } from "../src/tools.ts";

let cwd: string;
let agentDir: string;
let savedEnv: string | undefined;
const events: Array<{ event: string; data: unknown }> = [];
const deps = {
  recallLimit: () => 3,
  emit: (event: string, data: unknown) => {
    events.push({ event, data });
  },
};
const ctx = () => ({ sessionManager: { getCwd: () => cwd } }) as unknown as ExtensionContext;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-mem-cwd-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-mem-agent-"));
  savedEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir; // isolate the "global" scope too
  events.length = 0;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

const write = buildWriteTool(deps);
const recall = buildRecallTool(deps);
const runWrite = (params: Parameters<typeof write.execute>[1]) =>
  write.execute("id", params, undefined, undefined, ctx());
const runRecall = (params: Parameters<typeof recall.execute>[1]) =>
  recall.execute("id", params, undefined, undefined, ctx());
const textOf = (r: { content: Array<unknown> }) => (r.content[0] as { text: string }).text;

test("write then recall by name round-trips the body and emits memory:wrote", async () => {
  await runWrite({ name: "pref-x", description: "a pref", content: "Always do X.", type: "user", scope: "project" });
  expect(events.some((e) => e.event === "memory:wrote")).toBe(true);
  expect(textOf(await runRecall({ name: "pref-x" }))).toContain("Always do X.");
});

test("write refuses content containing a secret", async () => {
  await expect(
    runWrite({
      name: "leak",
      description: "d",
      content: "here is a key -----BEGIN PRIVATE KEY-----",
      type: "reference",
      scope: "project",
    }),
  ).rejects.toThrow("secrets");
});

test("recall by query returns only matching memories", async () => {
  await runWrite({ name: "alpha", description: "about apples", content: "apple pie", type: "reference", scope: "project" });
  await runWrite({ name: "beta", description: "about boats", content: "sailing", type: "reference", scope: "project" });
  const text = textOf(await runRecall({ query: "apple" }));
  expect(text).toContain("alpha");
  expect(text).not.toContain("beta");
});

test("recall with neither name nor query says nothing matched when empty", async () => {
  expect(textOf(await runRecall({}))).toContain("no matching memories");
});
