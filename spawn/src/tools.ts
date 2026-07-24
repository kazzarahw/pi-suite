import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "./agents.ts";
import { runAgent, type SpawnEvent, type SpawnResult } from "./runner.ts";
import { runParallel, type Job } from "./pool.ts";
import { eventToLine } from "./render.ts";

const parameters = Type.Object({
  tasks: Type.Array(
    Type.Object({
      agent: Type.String({ description: "Name of the agent to delegate to (from the available roster)." }),
      task: Type.String({
        description: "The task to delegate — described fully and self-contained; the subagent has no other context.",
      }),
    }),
    {
      description:
        "One or more delegations. A single element runs solo; multiple run in parallel under a concurrency cap and return in input order.",
    },
  ),
});
type SpawnParams = Static<typeof parameters>;

/** Refuse to spawn beyond this nesting depth (fork-bomb guard). */
const MAX_DEPTH = 2;

export interface SpawnDeps {
  discoverAgents: (cwd: string) => AgentDef[];
  defaultModel: () => string;
  concurrency: () => number;
  emit: (event: string, data: unknown) => void;
  /** This process's spawn nesting depth (from PI_SPAWN_DEPTH). */
  depth: number;
  /** Env to hand child subprocesses (carries the incremented depth). */
  childEnv: () => Record<string, string>;
}

export function buildSpawnTool(deps: SpawnDeps) {
  return {
    name: "spawn",
    label: "Spawn",
    description:
      "Delegate one or more tasks to specialized subagents that run in isolated context (a fresh pi process each) and report back. Use it to parallelize independent work or to keep heavy exploration out of your own context. Pass one task to run solo, or several to run in parallel.",
    promptSnippet: "Delegate independent tasks to isolated subagents; one runs solo, many run in parallel.",
    parameters,
    async execute(
      _toolCallId: string,
      params: SpawnParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ results: SpawnResult[] }>> {
      if (deps.depth >= MAX_DEPTH) {
        throw new Error(`[pi-spawn] max spawn depth (${MAX_DEPTH}) reached; refusing to nest further.`);
      }

      const cwd = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
      const agents = deps.discoverAgents(cwd);
      const byName = new Map(agents.map((a) => [a.name, a]));

      const jobs: Job[] = params.tasks.map((t) => {
        const def = byName.get(t.agent);
        if (!def) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          throw new Error(`[pi-spawn] unknown agent "${t.agent}". Available: ${available}.`);
        }
        const agentDef = def.model ? def : { ...def, model: deps.defaultModel() || undefined };
        return { agentDef, task: t.task };
      });

      const env = deps.childEnv();
      const status: Record<string, string> = {};
      const paint = () =>
        ctx?.ui?.setWidget?.(
          "spawn",
          Object.entries(status).map(([agent, line]) => `${agent}: ${line}`),
        );
      const onEventFor = (agent: string) => (e: SpawnEvent) => {
        status[agent] = eventToLine(e);
        paint();
      };

      let results: SpawnResult[];
      try {
        if (jobs.length === 1) {
          const job = jobs[0]!;
          deps.emit("spawn:started", { agent: job.agentDef.name });
          status[job.agentDef.name] = "starting…";
          paint();
          const result = await runAgent({ ...job, signal, env, onEvent: onEventFor(job.agentDef.name) });
          deps.emit("spawn:finished", { agent: result.agent, summary: result.output.slice(0, 200) });
          results = [result];
        } else {
          for (const job of jobs) {
            deps.emit("spawn:started", { agent: job.agentDef.name });
            status[job.agentDef.name] = "queued…";
          }
          paint();
          results = await runParallel(
            jobs,
            deps.concurrency(),
            (job, s) => runAgent({ ...job, signal: s, env, onEvent: onEventFor(job.agentDef.name) }),
            signal,
          );
          for (const result of results) {
            deps.emit("spawn:finished", { agent: result.agent, summary: result.output.slice(0, 200) });
          }
        }
      } finally {
        ctx?.ui?.setWidget?.("spawn", undefined);
      }

      const text = results
        .map((r) => `## ${r.agent} ${r.ok ? "✓" : "✗ (failed)"}\n${r.output || "(no output)"}`)
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { results } };
    },
  };
}
