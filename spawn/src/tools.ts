import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "./agents.ts";
import { runAgent, type RunAgentInput, type SpawnEvent, type SpawnResult } from "./runner.ts";
import { runParallel, type Job } from "./pool.ts";
import { eventToLine } from "./render.ts";
import { type Emitter, cwdOf, projectTrusted, truncateForAgent } from "../../shared/index.ts";
import { renderToolCall } from "../../shared/tool-render.ts";

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

/**
 * The interesting half of a spawn call, as one line: `reviewer`, or
 * `scout, worker ×2` when several run at once. Pure, so it needs no terminal.
 */
export function describeCall(params: SpawnParams): string {
  const tasks = params.tasks ?? [];
  if (tasks.length === 0) return "";
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.agent, (counts.get(t.agent) ?? 0) + 1);
  return [...counts]
    .map(([agent, n]) => (n > 1 ? `${agent} ×${n}` : agent))
    .join(", ");
}

export interface SpawnDeps {
  discoverAgents: (cwd: string, includeProject: boolean) => AgentDef[];
  defaultModel: () => string;
  concurrency: () => number;
  /** Per-job deadline in ms. */
  jobTimeoutMs: () => number;
  emit: Emitter;
  /** This process's spawn nesting depth (from PI_SPAWN_DEPTH). */
  depth: number;
  /** Env to hand child subprocesses (carries the incremented depth). */
  childEnv: () => Record<string, string>;
  /**
   * Run one delegated job. Defaults to {@link runAgent}; injected in tests.
   *
   * The tool used to call `runAgent` directly, which meant every path past the two
   * guards — the widget, the event pairs, the single-versus-parallel split, the
   * truncation — could only be reached by launching real `pi` subprocesses. None of it
   * was tested. `runAgent` already takes an injectable `SpawnFn` for the same reason;
   * this is that seam one level up.
   */
  runOne?: (input: RunAgentInput) => Promise<SpawnResult>;
}

export function buildSpawnTool(deps: SpawnDeps) {
  const runOne = deps.runOne ?? ((input: RunAgentInput) => runAgent(input));
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

      const cwd = cwdOf(ctx);
      const agents = deps.discoverAgents(cwd, projectTrusted(ctx));
      const byName = new Map(agents.map((a) => [a.name, a]));

      const jobs: Job[] = params.tasks.map((t) => {
        const def = byName.get(t.agent);
        if (!def) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          throw new Error(`[pi-spawn] unknown agent "${t.agent}". Available: ${available}.`);
        }
        const agentDef = def.model ? def : { ...def, model: deps.defaultModel() || undefined };
        return { agentDef, task: t.task, cwd };
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
          deps.emit("spawn:started", { agent: job.agentDef.name, cwd });
          status[job.agentDef.name] = "starting…";
          paint();
          const result = await runOne({
            ...job,
            signal,
            env,
            timeoutMs: deps.jobTimeoutMs(),
            onEvent: onEventFor(job.agentDef.name),
          });
          deps.emit("spawn:finished", { agent: result.agent, cwd, summary: result.output.slice(0, 200) });
          results = [result];
        } else {
          for (const job of jobs) {
            deps.emit("spawn:started", { agent: job.agentDef.name, cwd });
            status[job.agentDef.name] = "queued…";
          }
          paint();
          results = await runParallel(
            jobs,
            deps.concurrency(),
            (job, s) =>
              runOne({
                ...job,
                signal: s,
                env,
                timeoutMs: deps.jobTimeoutMs(),
                onEvent: onEventFor(job.agentDef.name),
              }),
            signal,
          );
          for (const result of results) {
            deps.emit("spawn:finished", { agent: result.agent, cwd, summary: result.output.slice(0, 200) });
          }
        }
      } finally {
        ctx?.ui?.setWidget?.("spawn", undefined);
      }

      const text = results
        .map((r) => `## ${r.agent} ${r.ok ? "✓" : "✗ (failed)"}\n${r.output || "(no output)"}`)
        .join("\n\n");
      return {
        content: [{ type: "text", text: truncateForAgent(text, { label: "spawn output", keep: "tail" }) }],
        details: { results },
      };
    },
    renderCall(args: SpawnParams, theme: Theme, context?: { lastComponent?: unknown }) {
      return renderToolCall("spawn", describeCall(args), theme, context?.lastComponent);
    },
  };
}
