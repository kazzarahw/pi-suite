import type { ExecFn } from "../../shared/exec.ts";
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

/** One search hit, as the reader's text rendering exposes it. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** How many hits a search reports. Beyond this the tail is dropped, and said to be. */
export const MAX_SEARCH_RESULTS = 8;

/** The reader marks each result with a bare `##`; everything before the first is furniture. */
const RESULT_MARKER = "##";

/**
 * Pull the results out of a search engine's rendered page. Pure. `null` when the page
 * does not have the expected shape.
 *
 * `search` is `read` pointed at an engine, so what came back was the *whole page* as
 * text. DuckDuckGo's HTML endpoint opens with its region selector: a search for three
 * words returned 221 lines of which the first 138 were the names of countries, and all of
 * it went verbatim into the transcript and into the model's context, ahead of anything
 * relevant, on every search.
 *
 * `null` rather than an empty list when no marker is found, so the caller falls back to
 * the raw text. An engine that changes its layout should degrade to the old noisy
 * behavior, never to silence — returning nothing would turn a cosmetic change upstream
 * into a search tool that reports no results.
 */
export function parseSearchResults(output: string): SearchResult[] | null {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of output.split("\n")) {
    if (line.trim() === RESULT_MARKER) {
      current = [];
      blocks.push(current);
      continue;
    }
    if (current === null) continue; // ahead of the first marker: the page's own chrome
    const text = line.trim();
    if (text) current.push(text);
  }
  if (blocks.length === 0) return null;

  const results: SearchResult[] = [];
  for (const block of blocks) {
    const [title, url, ...rest] = block;
    if (!title || !url) continue;
    // A trailing "Feedback" link closes the page and would otherwise be read as part of
    // the last result's snippet.
    results.push({ title, url, snippet: rest.filter((l) => l !== "Feedback").join(" ") });
  }
  return results.length > 0 ? results : null;
}

/**
 * Render search results compactly, or `null` when the page could not be parsed.
 *
 * Numbered so the agent can refer to a hit by position, and capped — with the drop
 * stated rather than silent, the standard the rest of the suite's caps hold to.
 */
export function formatSearchResults(output: string, max: number = MAX_SEARCH_RESULTS): string | null {
  const results = parseSearchResults(output);
  if (!results) return null;
  const shown = results.slice(0, max);
  const lines = shown.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
  if (results.length > shown.length) {
    lines.push(`(${results.length - shown.length} more result(s) not shown)`);
  }
  return lines.join("\n\n");
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
  /**
   * The session's project. agent-browser resolves relative paths against its own cwd,
   * so without this a `screenshot docs/shot.png` landed beside whatever directory the
   * extension host happened to start in rather than in the project the agent is working on.
   */
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const sessionArgs = cfg.session ? ["--session", cfg.session] : [];

  // search: try each keyless engine until one returns usable (non-blocked) results.
  if (action === "search") {
    const query = req(args.query, "query", "search");
    let last = "";
    for (const build of SEARCH_URLS) {
      const { stdout, code } = await exec(cfg.binPath, [...sessionArgs, "read", build(query)], {
        cwd,
        signal,
      });
      const out = stdout.trim();
      // Extracted where the page parses, raw where it does not: a layout change upstream
      // should cost noise, never results.
      if (code === 0 && !looksBlocked(out)) return formatSearchResults(out) ?? out;
      if (out) last = out;
    }
    return last || "(search returned no usable results — try the 'open' action on a specific URL)";
  }

  const argv = [...sessionArgs, ...browserArgv(action, args)];
  const { stdout, stderr, code } = await exec(cfg.binPath, argv, { cwd, signal });
  if (code !== 0) {
    throw new Error(`[pi-browser] agent-browser ${action} failed (${code}): ${stderr.trim() || "(no stderr)"}`);
  }
  return stdout.trim();
}
