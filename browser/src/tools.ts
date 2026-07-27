import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ExecFn } from "../../shared/exec.ts";
import type { BrowserConfig } from "./config.ts";
import { runBrowser, type BrowserAction } from "./browser.ts";
import { cwdOf, truncateForAgent } from "../../shared/index.ts";
import { renderToolCall } from "../../shared/tool-render.ts";

const ACTIONS = [
  "open", "snapshot", "read", "search", "click", "type", "fill", "press", "hover",
  "select", "check", "uncheck", "scroll", "wait", "screenshot", "back", "forward", "reload", "get",
] as const;

const parameters = Type.Object({
  action: StringEnum(ACTIONS, { description: "The browser action to perform." }),
  url: Type.Optional(
    Type.String({ description: "URL — required for 'open'; optional for 'read' (reads the current page if omitted)." }),
  ),
  query: Type.Optional(Type.String({ description: "Search query — required for 'search'." })),
  ref: Type.Optional(
    Type.String({
      description:
        "Element target: an @ref from a snapshot, or a CSS selector — for click/type/fill/hover/select/check/uncheck, and optionally 'get'.",
    }),
  ),
  text: Type.Optional(Type.String({ description: "Text to enter — for 'type' and 'fill'." })),
  key: Type.Optional(Type.String({ description: "Key to press (e.g. Enter, Tab, Control+a) — for 'press'." })),
  values: Type.Optional(Type.Array(Type.String(), { description: "Option value(s) to select — for 'select'." })),
  direction: Type.Optional(StringEnum(["up", "down", "left", "right"], { description: "Scroll direction — for 'scroll'." })),
  amount: Type.Optional(Type.Number({ description: "Scroll distance in pixels — for 'scroll' (optional)." })),
  path: Type.Optional(Type.String({ description: "Output file path — for 'screenshot' (optional)." })),
  what: Type.Optional(
    StringEnum(["text", "html", "value", "title", "url", "count"], { description: "What to read — for 'get'." }),
  ),
  wait: Type.Optional(Type.String({ description: "A selector to wait for, or milliseconds — for 'wait'." })),
});
type BrowserParams = Static<typeof parameters>;

export interface BrowserToolDeps {
  loadConfig: () => BrowserConfig;
  exec: ExecFn;
}

/**
 * The interesting half of a browser call, as one line: `search "pi extensions"`,
 * `open https://pi.dev`, `click @ref12`.
 *
 * Pi's default renderer knows the shape of its own built-in tools — a `read` row shows
 * the path, a `bash` row shows the command — but a custom tool renders as its bare name.
 * Every `browser` call therefore appeared as the word `browser` and nothing else, so the
 * one thing a user watching wants to know (what is it doing, and to which page?) was the
 * one thing not on screen, immediately followed by a screenful of page text.
 *
 * Pure, so the wording is testable without a terminal. Every extension has one of these
 * now; the row itself is composed by `shared/tool-render.ts`.
 */
export function describeCall(params: BrowserParams): string {
  const detail =
    params.query ??
    params.url ??
    params.ref ??
    params.what ??
    (params.action === "scroll" ? params.direction : undefined) ??
    params.key ??
    params.path ??
    "";
  return detail ? `${params.action} ${detail}` : params.action;
}

export function buildBrowserTool(deps: BrowserToolDeps) {
  return {
    name: "browser",
    label: "Browser",
    description:
      "Drive a real browser and the web via the agent-browser CLI. Use 'search' to look something up (keyless), 'open'+'snapshot' to load a page and get actionable @refs, 'click'/'type'/'fill'/'press' to interact, and 'read' to get a page's text. The browser session persists across calls.",
    promptSnippet: "Browse the web: search, open pages, snapshot for @refs, click/type, read text.",
    parameters,
    async execute(
      _toolCallId: string,
      params: BrowserParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ action: BrowserAction }>> {
      // A browser action is the slowest thing in the suite — a page load, a search, a
      // headless click — and it used to run with nothing on screen at all. pi-browser
      // was the only extension with no user-facing surface of any kind.
      ctx?.ui?.setStatus?.("browser", `browser: ${describeCall(params)}…`);
      try {
        const output = await runBrowser(
          params.action,
          params,
          deps.loadConfig(),
          deps.exec,
          cwdOf(ctx),
          signal,
        );
        return {
          content: [
            { type: "text", text: truncateForAgent(output || "(no output)", { label: `browser ${params.action}` }) },
          ],
          details: { action: params.action },
        };
      } finally {
        // Cleared on the error path too: a status line left behind after a failed
        // `open` claims a page is still loading that never will.
        ctx?.ui?.setStatus?.("browser", undefined);
      }
    },
    renderCall(args: BrowserParams, theme: Theme, context?: { lastComponent?: unknown }) {
      return renderToolCall("browser", describeCall(args), theme, context?.lastComponent);
    },
  };
}
