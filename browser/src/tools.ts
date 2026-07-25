import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserConfig } from "./config.ts";
import { runBrowser, type BrowserAction, type ExecFn } from "./browser.ts";
import { truncateForAgent } from "../../shared/index.ts";

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
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ action: BrowserAction }>> {
      const output = await runBrowser(params.action, params, deps.loadConfig(), deps.exec, signal);
      return {
        content: [
          { type: "text", text: truncateForAgent(output || "(no output)", { label: `browser ${params.action}` }) },
        ],
        details: { action: params.action },
      };
    },
  };
}
