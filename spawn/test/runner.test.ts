import { test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import {
  buildAgentArgv,
  toSpawnEvent,
  extractText,
  runAgent,
  pipeProcessOutput,
  STDERR_TAIL_BYTES,
  type ProcStreams,
  type SpawnFn,
} from "../src/runner.ts";
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

// ---------------------------------------------------------------------------
// The stdio plumbing.
//
// Both halves of this were live defects that only a real `pi` subprocess could have
// shown, which is exactly why they were extracted out of `defaultSpawn` and given a
// structural seam: a deadlock and a decoding bug are not things to leave untested
// because the thing they happen inside is awkward to launch.
// ---------------------------------------------------------------------------

/** A child's stdout/stderr, as two streams a test can write to. */
const fakeProc = (): ProcStreams & { pushOut: (b: Buffer | string) => void; pushErr: (s: string) => void } => {
  const out = new PassThrough();
  const err = new PassThrough();
  return {
    stdout: out as unknown as ProcStreams["stdout"],
    stderr: err as unknown as ProcStreams["stderr"],
    pushOut: (b) => out.write(b),
    pushErr: (s) => err.write(s),
  };
};

/** Streams are async; let the data events land. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test("stdout is split into whole lines, with the trailing partial flushed at close", async () => {
  const proc = fakeProc();
  const lines: string[] = [];
  const { flush } = pipeProcessOutput(proc, (l) => lines.push(l));

  proc.pushOut('{"a":1}\n{"b":2}\n{"c"');
  await settle();
  expect(lines).toEqual(['{"a":1}', '{"b":2}']);

  proc.pushOut(':3}');
  await settle();
  flush();
  expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("a multi-byte character split across two chunks survives the decode", async () => {
  // The bug: `chunk.toString()` per Buffer turned each half of a split UTF-8 sequence
  // into U+FFFD, so the JSON line carrying it no longer parsed and the subagent's
  // message was dropped in silence. Model prose is full of these — "—", "✓", any
  // non-English text — so this was the common path, not an exotic one.
  const proc = fakeProc();
  const lines: string[] = [];
  pipeProcessOutput(proc, (l) => lines.push(l));

  const payload = Buffer.from('{"text":"café — ✓"}\n', "utf8");
  const cut = payload.indexOf(Buffer.from("é", "utf8")) + 1; // mid-character
  proc.pushOut(payload.subarray(0, cut));
  proc.pushOut(payload.subarray(cut));
  await settle();

  expect(lines).toEqual(['{"text":"café — ✓"}']);
  expect(JSON.parse(lines[0]!)).toEqual({ text: "café — ✓" });
});

test("stderr is drained, and kept as a bounded tail", async () => {
  // Draining is the point: stderr is piped, and a pipe nobody reads fills at ~64KB and
  // then blocks the child's next write forever. The tail is what makes a failed launch
  // reportable instead of an empty transcript.
  const proc = fakeProc();
  const { stderrTail } = pipeProcessOutput(proc, () => {});

  proc.pushErr("x".repeat(STDERR_TAIL_BYTES * 2));
  proc.pushErr("the end");
  await settle();

  const tail = stderrTail();
  expect(tail.length).toBe(STDERR_TAIL_BYTES);
  expect(tail).toEndWith("the end");
});
