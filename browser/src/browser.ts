import type { ExecFn } from "../../shared/exec.ts";
export type { ExecFn };
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

const req = (value: string | undefined, name: string, action: string): string => {
  if (value === undefined || value === "") {
    throw new Error(`[pi-browser] "${name}" is required for action "${action}"`);
  }
  return value;
};

/**
 * Keyless search endpoints, tried in order. DuckDuckGo's HTML endpoint is the most scrape-tolerant
 * (clean title/url/snippet results); Bing is the fallback. The DDG/Google JS sites bot-block headless
 * Chromium, so they're intentionally not used.
 */
export const SEARCH_URLS: Array<(query: string) => string> = [
  (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
];

const BLOCK_MARKERS =
  /captcha|unusual traffic|are you human|verify you are|wait a moment|too many requests|access denied|\b429\b|\b418\b/i;

/** Heuristic: does search output look like a bot-wall / empty page rather than real results? */
export function looksBlocked(output: string): boolean {
  const t = output.trim();
  return t.length < 40 || BLOCK_MARKERS.test(t);
}

/** Map an action + args to the `agent-browser` subcommand argv. Pure; throws on a missing required arg. */
export function browserArgv(action: BrowserAction, args: BrowserArgs): string[] {
  switch (action) {
    case "open":
      return ["open", req(args.url, "url", action)];
    case "read":
      return args.url ? ["read", args.url] : ["read"];
    case "search":
      // Single-shot form; runBrowser() tries the full SEARCH_URLS fallback chain for reliability.
      return ["read", SEARCH_URLS[0]!(req(args.query, "query", action))];
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

/** Run one agent-browser action, returning its stdout. Throws on a non-zero exit. */
export async function runBrowser(
  action: BrowserAction,
  args: BrowserArgs,
  cfg: BrowserConfig,
  exec: ExecFn,
  signal?: AbortSignal,
): Promise<string> {
  const sessionArgs = cfg.session ? ["--session", cfg.session] : [];

  // search: try each keyless engine until one returns usable (non-blocked) results.
  if (action === "search") {
    const query = req(args.query, "query", "search");
    let last = "";
    for (const build of SEARCH_URLS) {
      const { stdout, code } = await exec(cfg.binPath, [...sessionArgs, "read", build(query)], { signal });
      const out = stdout.trim();
      if (code === 0 && !looksBlocked(out)) return out;
      if (out) last = out;
    }
    return last || "(search returned no usable results — try the 'open' action on a specific URL)";
  }

  const argv = [...sessionArgs, ...browserArgv(action, args)];
  const { stdout, stderr, code } = await exec(cfg.binPath, argv, { signal });
  if (code !== 0) {
    throw new Error(`[pi-browser] agent-browser ${action} failed (${code}): ${stderr.trim() || "(no stderr)"}`);
  }
  return stdout.trim();
}
