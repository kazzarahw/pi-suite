import { test, expect } from "bun:test";
import { runParallel, type Job, type RunOne } from "../src/pool.ts";
import type { AgentDef } from "../src/agents.ts";

const def = (name: string): AgentDef => ({ name, description: "", systemPrompt: "" });
const jobs = (n: number): Job[] => Array.from({ length: n }, (_, i) => ({ agentDef: def(`a${i}`), task: `t${i}` }));

test("runParallel never exceeds the concurrency cap and preserves input order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const run: RunOne = async (job) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return { agent: job.agentDef.name, ok: true, output: job.task, usage: { turns: 1, tokens: 0, cost: 0 } };
  };
  const results = await runParallel(jobs(6), 2, run);
  expect(maxInFlight).toBeLessThanOrEqual(2);
  expect(results.map((r) => r.output)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
});

test("runParallel stops picking up jobs once aborted; un-run slots are cancelled", async () => {
  const ac = new AbortController();
  let started = 0;
  const run: RunOne = async (job) => {
    started += 1;
    if (started === 1) ac.abort();
    return { agent: job.agentDef.name, ok: true, output: "ran", usage: { turns: 0, tokens: 0, cost: 0 } };
  };
  const results = await runParallel(jobs(10), 1, run, ac.signal);
  expect(started).toBeLessThan(10);
  expect(results).toHaveLength(10);
  expect(results.some((r) => r.output.includes("cancelled"))).toBe(true);
});
