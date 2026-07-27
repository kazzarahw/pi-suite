import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSpawnTool, describeCall, type SpawnDeps } from "../src/tools.ts";
import type { AgentDef } from "../src/agents.ts";
import type { SpawnResult } from "../src/runner.ts";

/** The text of a tool result. Pi types content as a union; only text is produced here. */
const textOf = (r: { content: ReadonlyArray<{ type: string }> }): string =>
  (r.content[0] as unknown as { text: string }).text;

const baseDeps = (over: Partial<SpawnDeps> = {}): SpawnDeps => ({
  discoverAgents: () => [],
  defaultModel: () => "",
  concurrency: () => 2,
  jobTimeoutMs: () => 900_000,
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

// ---------------------------------------------------------------------------
// Execution. Everything past the two guards used to be reachable only by launching
// real `pi` subprocesses, so none of it was tested — the widget, the started/finished
// event pairs, the single-versus-parallel split, and the truncated transcript.
// `SpawnDeps.runOne` is the seam; `runAgent` already had the same one a level down.
// ---------------------------------------------------------------------------

const AGENTS: AgentDef[] = [
  { name: "scout", description: "d", systemPrompt: "" },
  { name: "builder", description: "d", model: "haiku", systemPrompt: "" },
];

interface Widget {
  id: string;
  lines?: string[];
}

/** A ctx that records widget paints, as the real one would render them. */
function widgetCtx(): { ctx: ExtensionContext; widgets: Widget[] } {
  const widgets: Widget[] = [];
  return {
    widgets,
    ctx: {
      ui: { setWidget: (id: string, lines?: string[]) => widgets.push({ id, lines }) },
    } as unknown as ExtensionContext,
  };
}

const ok = (agent: string, output = "done"): SpawnResult => ({
  agent,
  ok: true,
  output,
  usage: { turns: 1, tokens: 10, cost: 0 },
});

test("a single task runs solo and returns its output", async () => {
  const deps = baseDeps({ discoverAgents: () => AGENTS, runOne: async (i) => ok(i.agentDef.name) });
  const result = await run(deps, [{ agent: "scout", task: "t" }]);
  expect(result.details.results).toHaveLength(1);
  expect(textOf(result)).toContain("## scout ✓");
});

test("a single task emits started then finished, with a summary", async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    emit: (event, data) => events.push({ event, data }),
    runOne: async (i) => ok(i.agentDef.name, "the answer"),
  });
  await run(deps, [{ agent: "scout", task: "t" }]);
  expect(events.map((e) => e.event)).toEqual(["spawn:started", "spawn:finished"]);
  expect(events[1]!.data).toMatchObject({ agent: "scout", summary: "the answer" });
});

test("several tasks run in parallel and return in input order", async () => {
  // Order matters: the agent correlates results with the tasks it sent, positionally.
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    concurrency: () => 2,
    runOne: async (i) => {
      // Finish "scout" last, so completion order differs from input order.
      if (i.agentDef.name === "scout") await new Promise((r) => setTimeout(r, 10));
      return ok(i.agentDef.name);
    },
  });
  const result = await run(deps, [
    { agent: "scout", task: "a" },
    { agent: "builder", task: "b" },
  ]);
  expect(result.details.results.map((r) => r.agent)).toEqual(["scout", "builder"]);
});

test("several tasks emit one started per job, then one finished per result", async () => {
  const events: string[] = [];
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    emit: (event) => events.push(event),
    runOne: async (i) => ok(i.agentDef.name),
  });
  await run(deps, [
    { agent: "scout", task: "a" },
    { agent: "builder", task: "b" },
  ]);
  expect(events).toEqual([
    "spawn:started",
    "spawn:started",
    "spawn:finished",
    "spawn:finished",
  ]);
});

test("a failed job is reported as failed rather than dropped", async () => {
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    runOne: async (i) => ({ ...ok(i.agentDef.name), ok: false, output: "" }),
  });
  const result = await run(deps, [{ agent: "scout", task: "t" }]);
  expect(textOf(result)).toContain("## scout ✗ (failed)");
  expect(textOf(result)).toContain("(no output)");
});

test("the widget is painted while running and cleared when done", async () => {
  const { ctx, widgets } = widgetCtx();
  const deps = baseDeps({ discoverAgents: () => AGENTS, runOne: async (i) => ok(i.agentDef.name) });
  await buildSpawnTool(deps).execute("id", { tasks: [{ agent: "scout", task: "t" }] }, undefined, undefined, ctx);
  expect(widgets.length).toBeGreaterThan(1);
  expect(widgets.every((w) => w.id === "spawn")).toBe(true);
  // A widget left behind would outlive the work it describes.
  expect(widgets.at(-1)!.lines).toBeUndefined();
});

test("the widget is cleared even when a job throws", async () => {
  const { ctx, widgets } = widgetCtx();
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    runOne: async () => {
      throw new Error("boom");
    },
  });
  await expect(
    buildSpawnTool(deps).execute("id", { tasks: [{ agent: "scout", task: "t" }] }, undefined, undefined, ctx),
  ).rejects.toThrow("boom");
  expect(widgets.at(-1)!.lines).toBeUndefined();
});

test("streamed events reach the widget as progress lines", async () => {
  const { ctx, widgets } = widgetCtx();
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    runOne: async (i) => {
      i.onEvent?.({ kind: "tool", text: "read" });
      return ok(i.agentDef.name);
    },
  });
  await buildSpawnTool(deps).execute("id", { tasks: [{ agent: "scout", task: "t" }] }, undefined, undefined, ctx);
  expect(widgets.some((w) => w.lines?.some((l) => l.includes("⚙ read")))).toBe(true);
});

test("an agent without its own model gets the configured default", async () => {
  let seen: string | undefined = "unset";
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    defaultModel: () => "sonnet",
    runOne: async (i) => {
      seen = i.agentDef.model;
      return ok(i.agentDef.name);
    },
  });
  await run(deps, [{ agent: "scout", task: "t" }]);
  expect(seen).toBe("sonnet");
});

test("an agent that pins its own model keeps it", async () => {
  let seen: string | undefined;
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    defaultModel: () => "sonnet",
    runOne: async (i) => {
      seen = i.agentDef.model;
      return ok(i.agentDef.name);
    },
  });
  await run(deps, [{ agent: "builder", task: "t" }]);
  expect(seen).toBe("haiku");
});

test("the child env carries the incremented depth to every job", async () => {
  const envs: Array<Record<string, string> | undefined> = [];
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    childEnv: () => ({ PI_SPAWN_DEPTH: "1" }),
    runOne: async (i) => {
      envs.push(i.env);
      return ok(i.agentDef.name);
    },
  });
  await run(deps, [
    { agent: "scout", task: "a" },
    { agent: "builder", task: "b" },
  ]);
  expect(envs).toEqual([{ PI_SPAWN_DEPTH: "1" }, { PI_SPAWN_DEPTH: "1" }]);
});

test("the per-job deadline is passed through", async () => {
  let seen = 0;
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    jobTimeoutMs: () => 1234,
    runOne: async (i) => {
      seen = i.timeoutMs ?? 0;
      return ok(i.agentDef.name);
    },
  });
  await run(deps, [{ agent: "scout", task: "t" }]);
  expect(seen).toBe(1234);
});

test("a long transcript is truncated, keeping the tail", async () => {
  // Tail, not head: a subagent's conclusion is at the end, and Pi requires tools to
  // truncate rather than letting a full transcript into the context.
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    runOne: async (i) => ok(i.agentDef.name, "line\n".repeat(5000)),
  });
  const result = await run(deps, [{ agent: "scout", task: "t" }]);
  expect(textOf(result)).toContain("truncated");
  expect(result.details.results[0]!.output.split("\n").length).toBeGreaterThan(4000);
});

test("the tool hands each job the session cwd, and announces it on the bus", async () => {
  // Two halves of the same defect. `runAgent` never received a cwd, so subagents ran in
  // the extension host's directory; and `spawn:started` never carried one, so pi-git —
  // which gets `data` and nothing else on a bus callback — could not guard the right
  // project even once it subscribed.
  const seen: string[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const deps = baseDeps({
    discoverAgents: () => AGENTS,
    emit: (event, data) => events.push({ event, data }),
    runOne: async (i) => {
      seen.push(i.cwd);
      return ok(i.agentDef.name);
    },
  });
  const ctx = {
    sessionManager: { getCwd: () => "/tmp/pi-spawn-session-cwd" },
  } as unknown as ExtensionContext;
  await buildSpawnTool(deps).execute(
    "id",
    { tasks: [{ agent: "scout", task: "t" }, { agent: "builder", task: "u" }] },
    undefined,
    undefined,
    ctx,
  );

  expect(seen).toEqual(["/tmp/pi-spawn-session-cwd", "/tmp/pi-spawn-session-cwd"]);
  for (const e of events) {
    expect((e.data as { cwd?: string }).cwd).toBe("/tmp/pi-spawn-session-cwd");
  }
});

// The row a user watching actually reads. Pure, so it needs no terminal.
test("describeCall names the agents, collapsing repeats into a count", () => {
  expect(describeCall({ tasks: [{ agent: "reviewer", task: "t" }] })).toBe("reviewer");
  expect(
    describeCall({
      tasks: [
        { agent: "scout", task: "t" },
        { agent: "worker", task: "t" },
        { agent: "worker", task: "t" },
      ],
    }),
  ).toBe("scout, worker \u00d72");
  expect(describeCall({ tasks: [] })).toBe("");
});
