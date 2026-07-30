import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deadline } from "../../shared/index.ts";
import type { AgentDef } from "./agents.ts";

export interface SpawnResult {
  agent: string;
  ok: boolean;
  output: string;
  usage: { turns: number; tokens: number; cost: number };
}

export interface SpawnEvent {
  kind: "tool" | "text" | "final" | "error";
  text: string;
}

/** Injectable process runner: builds/streams a `pi` subprocess. Tests fake this. */
export type SpawnFn = (
  argv: string[],
  opts: {
    /** Required — see {@link RunAgentInput.cwd}. */
    cwd: string;
    signal?: AbortSignal;
    env?: Record<string, string>;
    onLine: (line: string) => void;
  },
) => Promise<number>;

export interface RunAgentInput {
  agentDef: AgentDef;
  task: string;
  /**
   * The project the subagent works in — `cwdOf(ctx)`, resolved by the tool.
   *
   * **Required, and the reason is the whole point of `shared/cwd.ts`.** This used not
   * to exist: `nodeSpawn` was called with no `cwd`, so the child silently inherited the
   * extension host's `process.cwd()`. Where that differed from Pi's session cwd, a
   * delegated subagent read and *edited files in the wrong project* — the most damaging
   * instance of the bug the shared resolver was introduced to end, and the one its
   * source-scan guard could never see, because inheriting `process.cwd()` by omission
   * matches no text.
   */
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onEvent?: (e: SpawnEvent) => void;
  /**
   * Per-job deadline in ms. Applied here rather than at the call site so each job's
   * clock starts when *it* starts: under a concurrency cap a queued job would otherwise
   * inherit a deadline that had already been running while it waited.
   */
  timeoutMs?: number;
}

/** Construct the `pi --mode json` argv for a delegated task. Pure. */
export function buildAgentArgv(agentDef: AgentDef, task: string, promptFile?: string): string[] {
  const argv = ["--mode", "json", "-p", "--no-session"];
  if (agentDef.model) argv.push("--model", agentDef.model);
  if (agentDef.tools && agentDef.tools.length > 0) argv.push("--tools", agentDef.tools.join(","));
  if (promptFile) argv.push("--append-system-prompt", promptFile);
  argv.push(`Task: ${task}`);
  return argv;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  usage?: { input?: number; output?: number; cost?: { total?: number } };
  errorMessage?: string;
}

/** Concatenate the text parts of an assistant message. Pure. */
export function extractText(message: MessageLike): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(
        (p): p is { type: string; text: string } =>
          !!p && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** Map a parsed JSON event to a concise streaming event, or null to ignore. Pure. */
export function toSpawnEvent(json: { type?: string; toolName?: string; message?: MessageLike }): SpawnEvent | null {
  switch (json.type) {
    case "tool_execution_start":
      return { kind: "tool", text: json.toolName ?? "tool" };
    case "message_end": {
      if (json.message?.role !== "assistant") return null;
      if (json.message.errorMessage) return { kind: "error", text: json.message.errorMessage };
      const text = extractText(json.message);
      return text ? { kind: "text", text } : null;
    }
    case "agent_end":
      return { kind: "final", text: "" };
    default:
      return null;
  }
}

function writeTempPrompt(agentName: string, prompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-spawn-"));
  const file = join(dir, `prompt-${agentName.replace(/[^\w.-]+/g, "_")}.md`);
  writeFileSync(file, prompt, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** Resolve how to invoke `pi` as a subprocess (mirrors the bundled subagent example). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

/** How much of a failing child's stderr is kept for the error report. */
export const STDERR_TAIL_BYTES = 4096;

/** How long a cancelled child gets to honour SIGTERM before it is killed outright. */
export const KILL_GRACE_MS = 3000;

/** The slice of a child process this plumbing touches — structural, so a test can fake it. */
export interface ProcStreams {
  stdout: { setEncoding(enc: BufferEncoding): unknown; on(ev: "data", cb: (chunk: string) => void): unknown };
  stderr: { setEncoding(enc: BufferEncoding): unknown; on(ev: "data", cb: (chunk: string) => void): unknown };
}

/**
 * Wire a child's stdout to `onLine` and drain its stderr.
 *
 * Extracted from the spawn itself because both halves are load-bearing and neither could
 * be exercised without launching a real `pi`:
 *
 * - **stdout is decoded with `setEncoding`, never `chunk.toString()`.** A chunk boundary
 *   can fall inside a multi-byte UTF-8 character, and decoding each Buffer on its own
 *   turns the two halves into replacement characters — which corrupts the JSON line
 *   carrying them, so `JSON.parse` throws and the subagent's message is dropped in
 *   silence. For a stream whose payload is model prose that is the common case, not an
 *   exotic one. Node's `StringDecoder` holds the partial sequence until the rest arrives.
 * - **stderr MUST be consumed.** It is piped, and a pipe nobody reads fills at ~64KB and
 *   then blocks the child's next write *forever* — so a subagent that logs enough to
 *   stderr deadlocked until its deadline killed it, having produced nothing at all.
 *
 * Returns `flush` for the trailing partial line at close, and the bounded stderr tail, so
 * a failed launch has something to say instead of an empty transcript.
 */
export function pipeProcessOutput(
  proc: ProcStreams,
  onLine: (line: string) => void,
): { flush: () => void; stderrTail: () => string } {
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  });

  let errTail = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    errTail = (errTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  return {
    flush: () => {
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    },
    stderrTail: () => errTail,
  };
}

const defaultSpawn: SpawnFn = (argv, opts) =>
  new Promise((resolve) => {
    const { command, args } = getPiInvocation(argv);
    const proc = nodeSpawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    const streams = pipeProcessOutput(proc as unknown as ProcStreams, opts.onLine);

    proc.on("close", (code) => {
      streams.flush();
      const tail = streams.stderrTail().trim();
      // Not on an abort. Esc and a deadline both stop the child with a signal, so "exited
      // non-zero with something on stderr" is the ordinary shape of a *cancellation* —
      // reporting it dumped up to STDERR_TAIL_BYTES of the subagent's log into the
      // terminal every time the user pressed Escape. What this line is for is a launch
      // that failed on its own, where the transcript would otherwise be empty.
      if (code !== 0 && tail && opts.signal?.aborted !== true) {
        console.error(`[pi-spawn] subagent process exited ${code}: ${tail}`);
      }
      resolve(code ?? 0);
    });
    proc.on("error", () => resolve(1));
    if (opts.signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        // `exitCode`/`signalCode`, not `proc.killed`. `killed` only records that a signal
        // was successfully *sent*, so the SIGTERM above sets it — which meant this branch
        // was never taken and the escalation was dead code: a subagent that ignores
        // SIGTERM was never actually stopped, and the job hung until Pi itself exited.
        const escalate = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        }, KILL_GRACE_MS);
        // Cleared once the child is gone: an armed timer holds the event loop open, so
        // every cancelled job would otherwise delay Pi's own exit by the grace period.
        proc.once("close", () => clearTimeout(escalate));
      };
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
  });

/** Run one delegated task in an isolated `pi` subprocess; parse its stream into a SpawnResult. */
export async function runAgent(input: RunAgentInput, spawn: SpawnFn = defaultSpawn): Promise<SpawnResult> {
  const { agentDef, task, cwd, signal, env, onEvent, timeoutMs } = input;
  // One signal carrying both reasons to stop: the user pressed Esc, or the job outlived
  // its deadline. The existing SIGTERM→SIGKILL escalation handles either.
  const bounded = timeoutMs ? deadline(timeoutMs, signal) : signal;
  const timedOut = (): boolean => timeoutMs !== undefined && bounded?.aborted === true && signal?.aborted !== true;
  const promptFile = agentDef.systemPrompt.trim() ? writeTempPrompt(agentDef.name, agentDef.systemPrompt) : undefined;
  const argv = buildAgentArgv(agentDef, task, promptFile);

  let output = "";
  let sawError = false;
  const usage = { turns: 0, tokens: 0, cost: 0 };

  try {
    const code = await spawn(argv, {
      cwd,
      signal: bounded,
      env,
      onLine: (line) => {
        if (!line.trim()) return;
        let json: { type?: string; toolName?: string; message?: MessageLike };
        try {
          json = JSON.parse(line);
        } catch {
          return;
        }
        const ev = toSpawnEvent(json);
        if (ev) onEvent?.(ev);
        if (json.type === "message_end" && json.message?.role === "assistant") {
          const text = extractText(json.message);
          if (text) output = text;
          usage.turns += 1;
          const u = json.message.usage;
          if (u) {
            usage.tokens += (u.input ?? 0) + (u.output ?? 0);
            usage.cost += u.cost?.total ?? 0;
          }
          if (json.message.errorMessage) sawError = true;
        }
      },
    });
    // A job killed at its deadline did not "fail" — it never finished. Say so, rather
    // than returning a truncated transcript that reads like a completed answer.
    if (timedOut()) {
      const partial = output.trim();
      return {
        agent: agentDef.name,
        ok: false,
        output: `[pi-spawn] ${agentDef.name} exceeded its ${timeoutMs}ms deadline and was terminated.${partial ? `\n\nPartial output:\n${partial}` : ""}`,
        usage,
      };
    }
    return { agent: agentDef.name, ok: code === 0 && !sawError, output: output.trim(), usage };
  } finally {
    if (promptFile && existsSync(promptFile)) {
      try {
        rmSync(dirname(promptFile), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
