import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSpawnTool, type SpawnDeps } from "../src/tools.ts";
import type { AgentDef } from "../src/agents.ts";

const baseDeps = (over: Partial<SpawnDeps> = {}): SpawnDeps => ({
  discoverAgents: () => [],
  defaultModel: () => "",
  concurrency: () => 2,
  emit: () => {},
  depth: 0,
  childEnv: () => ({}),
  ...over,
});
const run = (deps: SpawnDeps, tasks: Array<{ agent: string; task: string }>) =>
  buildSpawnTool(deps).execute("id", { tasks }, undefined, undefined, {} as unknown as ExtensionContext);

// The fork-bomb guard — refuses before any subprocess is launched.
test("refuses to spawn beyond max depth", async () => {
  await expect(run(baseDeps({ depth: 2 }), [{ agent: "scout", task: "t" }])).rejects.toThrow("max spawn depth");
});

test("throws on an unknown agent, listing what's available", async () => {
  const deps = baseDeps({ discoverAgents: () => [{ name: "scout", description: "d" } as unknown as AgentDef] });
  await expect(run(deps, [{ agent: "ghost", task: "t" }])).rejects.toThrow('unknown agent "ghost"');
});
