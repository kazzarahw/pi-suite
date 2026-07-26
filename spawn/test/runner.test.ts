import { test, expect } from "bun:test";
import { buildAgentArgv, toSpawnEvent, extractText, runAgent, type SpawnFn } from "../src/runner.ts";
import type { AgentDef } from "../src/agents.ts";
import { within } from "../../shared/test/harness.ts";

const agent: AgentDef = { name: "scout", description: "", tools: ["read", "grep"], model: "opus", systemPrompt: "" };

test("buildAgentArgv includes mode/model/tools/task; prompt file only when given", () => {
  expect(buildAgentArgv(agent, "look around")).toEqual([
    "--mode", "json", "-p", "--no-session", "--model", "opus", "--tools", "read,grep", "Task: look around",
  ]);
  expect(buildAgentArgv(agent, "x", "/tmp/p.md")).toContain("--append-system-prompt");
});

test("extractText concatenates text parts, ignoring non-text", () => {
  expect(extractText({ content: "hi" })).toBe("hi");
  expect(extractText({ content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] })).toBe("ab");
});

test("toSpawnEvent maps event types", () => {
  expect(toSpawnEvent({ type: "tool_execution_start", toolName: "read" })).toEqual({ kind: "tool", text: "read" });
  expect(
    toSpawnEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ).toEqual({ kind: "text", text: "done" });
  expect(toSpawnEvent({ type: "message_end", message: { role: "user", content: "x" } })).toBeNull();
});

test("runAgent parses a fed JSON stream into final output + accumulated usage", async () => {
  const lines = [
    `{"type":"session","version":3}`,
    `{"type":"tool_execution_start","toolName":"read"}`,
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"usage":{"input":10,"output":5,"cost":{"total":0.01}}}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}],"usage":{"input":3,"output":7,"cost":{"total":0.02}}}}`,
    `{"type":"agent_end","messages":[]}`,
  ];
  const kinds: string[] = [];
  const fakeSpawn: SpawnFn = async (_argv, opts) => {
    for (const l of lines) opts.onLine(l);
    return 0;
  };
  const r = await runAgent({ agentDef: { ...agent, systemPrompt: "" }, task: "t", cwd: process.cwd(), onEvent: (e) => kinds.push(e.kind) }, fakeSpawn);
  expect(r.ok).toBe(true);
  expect(r.output).toBe("final answer");
  expect(r.usage.turns).toBe(2);
  expect(r.usage.tokens).toBe(25);
  expect(r.usage.cost).toBeCloseTo(0.03, 5);
  expect(kinds).toContain("tool");
});

test("runAgent reports ok:false on a non-zero exit", async () => {
  const fakeSpawn: SpawnFn = async () => 1;
  const r = await runAgent({ agentDef: { ...agent, systemPrompt: "" }, task: "t", cwd: process.cwd() }, fakeSpawn);
  expect(r.ok).toBe(false);
});

// --- Per-job deadline ------------------------------------------------------
// spawn handled abort (SIGTERM→SIGKILL) but had no deadline, so a wedged subagent ran
// until a human noticed. The deadline is applied inside runAgent rather than at the call
// site so each job's clock starts when *it* starts: under a concurrency cap a queued job
// would otherwise inherit a deadline that had been running while it waited.

test("a job that never finishes is terminated at its deadline", async () => {
  let killed = false;
  const spawnFn: SpawnFn = (_argv, opts) =>
    new Promise((resolve) => {
      // Never resolves on its own; only the signal ends it, as a real wedged child would.
      opts.signal?.addEventListener("abort", () => {
        killed = true;
        resolve(1);
      });
    });
  const result = await within(
    3000,
    runAgent(
      { agentDef: agent, task: "t", cwd: process.cwd(), timeoutMs: 50 },
      spawnFn,
    ),
  );
  expect(killed).toBe(true);
  expect(result.ok).toBe(false);
  // Must read as "did not finish", not as an answer.
  expect(result.output).toContain("deadline");
});

test("a job finishing inside its deadline is unaffected", async () => {
  const spawnFn: SpawnFn = (_argv, opts) => {
    opts.onLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "done" } }));
    return Promise.resolve(0);
  };
  const result = await within(
    3000,
    runAgent(
      { agentDef: agent, task: "t", cwd: process.cwd(), timeoutMs: 10_000 },
      spawnFn,
    ),
  );
  expect(result.ok).toBe(true);
  expect(result.output).not.toContain("deadline");
});

// A user-initiated abort must stay distinguishable from a deadline kill.
test("a user abort is not reported as a timeout", async () => {
  const spawnFn: SpawnFn = (_argv, opts) =>
    new Promise((resolve) => opts.signal?.addEventListener("abort", () => resolve(1)));
  const ac = new AbortController();
  const p = runAgent(
    { agentDef: agent, task: "t", cwd: process.cwd(), signal: ac.signal, timeoutMs: 10_000 },
    spawnFn,
  );
  ac.abort();
  const result = await within(3000, p);
  expect(result.output).not.toContain("deadline");
});

test("runAgent launches the subagent in the project, not the extension host's directory", async () => {
  // The defect this closes: `nodeSpawn` was called with no `cwd`, so the child inherited
  // `process.cwd()`. Where that differed from Pi's session cwd — which is the whole
  // reason `shared/cwd.ts` exists — a delegated subagent read and *edited files in the
  // wrong project*, and `test/boundaries.test.ts`'s scan could not see it, because
  // inheriting by omission matches no text.
  let seen: string | undefined;
  const fakeSpawn: SpawnFn = async (_argv, opts) => {
    seen = opts.cwd;
    return 0;
  };
  await runAgent(
    { agentDef: { ...agent, systemPrompt: "" }, task: "t", cwd: "/tmp/some-other-project" },
    fakeSpawn,
  );
  expect(seen).toBe("/tmp/some-other-project");
});
