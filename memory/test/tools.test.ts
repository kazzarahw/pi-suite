import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildMemoryTool, describeCall } from "../src/tools.ts";

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

const memory = buildMemoryTool(deps);
type Params = Parameters<typeof memory.execute>[1];
const run = (params: Params) => memory.execute("id", params, undefined, undefined, ctx());
const runWrite = (params: Omit<Params, "action">) => run({ ...params, action: "write" } as Params);
const runRecall = (params: Omit<Params, "action">) => run({ ...params, action: "recall" } as Params);
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

/**
 * The schema cannot enforce `write`'s fields once both actions share one parameter
 * object, so the tool has to — and it must name every missing field at once rather than
 * failing on the first, which would cost one round-trip per field.
 */
test("write names every missing required field in one error", async () => {
  await expect(runWrite({ name: "half" })).rejects.toThrow(
    '[pi-memory] action "write" requires description, content, type, scope.',
  );
});

test("write treats a blank required field as missing", async () => {
  await expect(
    runWrite({ name: "", description: "d", content: "c", type: "user", scope: "project" }),
  ).rejects.toThrow(/requires name/);
});

test("recall is not held to write's required fields", async () => {
  expect(textOf(await runRecall({}))).toContain("no matching memories");
});

test("the result records which action ran, so a fork can reconstruct it", async () => {
  const wrote = await runWrite({
    name: "d", description: "d", content: "c", type: "user", scope: "project",
  });
  expect(wrote.details).toEqual({ action: "write", keys: ["d"] });
  expect((await runRecall({ name: "d" })).details).toEqual({ action: "recall", keys: ["d"] });
});

// The row a user watching actually reads. Pure, so it needs no terminal.
test("describeCall names the action and its target", () => {
  expect(describeCall({ action: "recall", name: "auth-flow" } as Params)).toBe("recall auth-flow");
  expect(describeCall({ action: "recall", query: "auth" } as Params)).toBe("recall auth");
  expect(describeCall({ action: "write", name: "api-quirks" } as Params)).toBe("write api-quirks");
  expect(describeCall({ action: "recall" } as Params)).toBe("recall");
  // A write's `query` is meaningless; the row must not borrow it as the target.
  expect(describeCall({ action: "write", query: "nope" } as Params)).toBe("write");
});

// ---------------------------------------------------------------------------
// The description is a behavioral surface, not documentation.
//
// The index injection is a table of contents of what is already stored; nothing in it, or
// anywhere else, tells an agent to store something new. So the description is the only
// surface that reaches an agent about writing. Across nine dogfooding sessions `write` was
// called zero times — including sessions that turned up exactly what memories are for.
// (Those sessions show zero recalls too, but the store held two test fixtures described as
// "body" and "test body content", so that number says nothing about recall's trigger.)
//
// So the write trigger is pinned. A later edit is free to reword it; one that deletes it
// should have to notice.
// ---------------------------------------------------------------------------

test("the description says when to write, unprompted, and when not to", () => {
  const d = memory.description;
  // Events an agent can notice happening, rather than a judgement about "durability" —
  // which is the wording that produced nothing.
  expect(d).toContain("WITHOUT being asked");
  expect(d).toContain("corrects you");
  expect(d).toContain("cost you effort to find");
  // The floor. A trigger without one turns every session into note-taking.
  expect(d).toContain("Do NOT write what the repository already records");
  expect(d).toContain("only true of the task in front of you");
});

test("the write trigger survives into the system prompt", () => {
  // The description is only read once the model is already considering the tool; an
  // unprompted write starts before that.
  expect(memory.promptSnippet).toContain("write one unprompted");
});

test("recall's trigger is left alone, since nothing measured it", () => {
  expect(memory.description).toContain("use it before acting when a memory's description looks relevant");
});

test("the type enum tells the agent which trigger maps to which type", () => {
  const type = (memory.parameters as { properties?: Record<string, { description?: string }> })
    .properties!.type!.description!;
  expect(type).toContain("feedback = a correction");
  expect(type).toContain("say why");
  expect(type).toContain("project = a fact about this repo");
});
