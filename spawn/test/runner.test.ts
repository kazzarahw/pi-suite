import { test, expect } from "bun:test";
import { buildAgentArgv, toSpawnEvent, extractText, runAgent, type SpawnFn } from "../src/runner.ts";
import type { AgentDef } from "../src/agents.ts";

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
  const r = await runAgent({ agentDef: { ...agent, systemPrompt: "" }, task: "t", onEvent: (e) => kinds.push(e.kind) }, fakeSpawn);
  expect(r.ok).toBe(true);
  expect(r.output).toBe("final answer");
  expect(r.usage.turns).toBe(2);
  expect(r.usage.tokens).toBe(25);
  expect(r.usage.cost).toBeCloseTo(0.03, 5);
  expect(kinds).toContain("tool");
});

test("runAgent reports ok:false on a non-zero exit", async () => {
  const fakeSpawn: SpawnFn = async () => 1;
  const r = await runAgent({ agentDef: { ...agent, systemPrompt: "" }, task: "t" }, fakeSpawn);
  expect(r.ok).toBe(false);
});
