import { execFile } from "node:child_process";
import type { BrowserConfig } from "./config.ts";

export type BrowserAction =
  | "open"
  | "snapshot"
  | "read"
  | "search"
  | "click"
  | "type"
  | "fill"
  | "press"
  | "hover"
  | "select"
  | "check"
  | "uncheck"
  | "scroll"
  | "wait"
  | "screenshot"
  | "back"
  | "forward"
  | "reload"
  | "get";

export interface BrowserArgs {
  url?: string;
  query?: string;
  ref?: string;
  text?: string;
  key?: string;
  values?: string[];
  direction?: string; // constrained to up/down/left/right by the tool's StringEnum
  amount?: number;
  path?: string;
  what?: string;
  wait?: string;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const req = (value: string | undefined, name: string, action: string): string => {
  if (value === undefined || value === "") {
    throw new Error(`[pi-browser] "${name}" is required for action "${action}"`);
  }
  return value;
};

/** Map an action + args to the `agent-browser` subcommand argv. Pure; throws on a missing required arg. */
export function browserArgv(action: BrowserAction, args: BrowserArgs): string[] {
  switch (action) {
    case "open":
      return ["open", req(args.url, "url", action)];
    case "read":
      return args.url ? ["read", args.url] : ["read"];
    case "search":
      // Bing returns results to a plain GET+read (DuckDuckGo bot-blocks headless browsers).
      return ["read", `https://www.bing.com/search?q=${encodeURIComponent(req(args.query, "query", action))}`];
    case "snapshot":
      return ["snapshot", "-i"];
    case "click":
      return ["click", req(args.ref, "ref", action)];
    case "type":
      return ["type", req(args.ref, "ref", action), req(args.text, "text", action)];
    case "fill":
      return ["fill", req(args.ref, "ref", action), req(args.text, "text", action)];
    case "press":
      return ["press", req(args.key, "key", action)];
    case "hover":
      return ["hover", req(args.ref, "ref", action)];
    case "select": {
      const ref = req(args.ref, "ref", action);
      if (!args.values || args.values.length === 0) {
        throw new Error(`[pi-browser] "values" is required for action "select"`);
      }
      return ["select", ref, ...args.values];
    }
    case "check":
      return ["check", req(args.ref, "ref", action)];
    case "uncheck":
      return ["uncheck", req(args.ref, "ref", action)];
    case "scroll": {
      const dir = args.direction ?? "down";
      return args.amount !== undefined ? ["scroll", dir, String(args.amount)] : ["scroll", dir];
    }
    case "wait":
      return ["wait", req(args.wait, "wait", action)];
    case "screenshot":
      return args.path ? ["screenshot", args.path] : ["screenshot"];
    case "back":
      return ["back"];
    case "forward":
      return ["forward"];
    case "reload":
      return ["reload"];
    case "get": {
      const what = req(args.what, "what", action);
      return args.ref ? ["get", what, args.ref] : ["get", what];
    }
  }
}

export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { signal: opts?.signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      const err = stderr && stderr.length > 0 ? stderr : error ? (error as Error).message : "";
      resolve({ stdout: stdout ?? "", stderr: err, code });
    });
  });

/** Run one agent-browser action, returning its stdout. Throws on a non-zero exit. */
export async function runBrowser(
  action: BrowserAction,
  args: BrowserArgs,
  cfg: BrowserConfig,
  exec: ExecFn,
  signal?: AbortSignal,
): Promise<string> {
  const sessionArgs = cfg.session ? ["--session", cfg.session] : [];
  const argv = [...sessionArgs, ...browserArgv(action, args)];
  const { stdout, stderr, code } = await exec(cfg.binPath, argv, { signal });
  if (code !== 0) {
    throw new Error(`[pi-browser] agent-browser ${action} failed (${code}): ${stderr.trim() || "(no stderr)"}`);
  }
  return stdout.trim();
}
