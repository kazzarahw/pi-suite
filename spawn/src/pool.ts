import type { AgentDef } from "./agents.ts";
import { runAgent, type SpawnResult } from "./runner.ts";

export interface Job {
  agentDef: AgentDef;
  task: string;
}

export type RunOne = (job: Job, signal?: AbortSignal) => Promise<SpawnResult>;

const cancelled = (agent: string, message: string): SpawnResult => ({
  agent,
  ok: false,
  output: `[pi-spawn] ${message}`,
  usage: { turns: 0, tokens: 0, cost: 0 },
});

/**
 * Run jobs with a bounded number in flight. Results preserve input order. Aborting
 * the signal stops picking up pending jobs (and `run` should kill in-flight ones);
 * un-run slots come back as cancelled results so the array stays dense.
 */
export async function runParallel(
  jobs: Job[],
  concurrency: number,
  run: RunOne = (job, signal) => runAgent({ ...job, signal }),
  signal?: AbortSignal,
): Promise<SpawnResult[]> {
  const results = new Array<SpawnResult | undefined>(jobs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) break;
      const i = next++;
      if (i >= jobs.length) break;
      const job = jobs[i]!;
      try {
        results[i] = await run(job, signal);
      } catch (error) {
        results[i] = cancelled(job.agentDef.name, (error as Error).message);
      }
    }
  };

  const width = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: width }, () => worker()));

  return jobs.map((job, i) => results[i] ?? cancelled(job.agentDef.name, "cancelled"));
}
