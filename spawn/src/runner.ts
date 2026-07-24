import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  opts: { signal?: AbortSignal; env?: Record<string, string>; onLine: (line: string) => void },
) => Promise<number>;

export interface RunAgentInput {
  agentDef: AgentDef;
  task: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onEvent?: (e: SpawnEvent) => void;
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

const defaultSpawn: SpawnFn = (argv, opts) =>
  new Promise((resolve) => {
    const { command, args } = getPiInvocation(argv);
    const proc = nodeSpawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let buffer = "";
    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) opts.onLine(line);
    });
    proc.on("close", (code) => {
      if (buffer.trim()) opts.onLine(buffer);
      resolve(code ?? 0);
    });
    proc.on("error", () => resolve(1));
    if (opts.signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 3000);
      };
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
  });

/** Run one delegated task in an isolated `pi` subprocess; parse its stream into a SpawnResult. */
export async function runAgent(input: RunAgentInput, spawn: SpawnFn = defaultSpawn): Promise<SpawnResult> {
  const { agentDef, task, signal, env, onEvent } = input;
  const promptFile = agentDef.systemPrompt.trim() ? writeTempPrompt(agentDef.name, agentDef.systemPrompt) : undefined;
  const argv = buildAgentArgv(agentDef, task, promptFile);

  let output = "";
  let sawError = false;
  const usage = { turns: 0, tokens: 0, cost: 0 };

  try {
    const code = await spawn(argv, {
      signal,
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
