# pi-browser — Build Spec

> Design/implementation spec. Decisions, responsibilities, interfaces, build
> order, acceptance criteria. No function bodies.

**Goal:** One coherent, house-style tool for the whole web — browser automation, page reading, and search — as a single `browser` tool wrapping the `agent-browser` CLI. No separate `web_search`/`web_fetch`.

**Architecture:** A thin wrapper. The one `browser` tool dispatches an `action` enum to `agent-browser` subcommands via an injectable exec, and returns agent-browser's text output. No engine, no HTTP client, no search API of our own — agent-browser already does browsing, `read [url]` (fetch), and search (open a search URL and read).

**Tech Stack:** TypeScript/ESM, Bun + `bun test`, `node:child_process` for `agent-browser`, `@earendil-works/pi-*` peers.

## Global Constraints

See `pi-shared/HOUSE-STYLE.md`. Application:
- **One tool** `browser` (an `action` `StringEnum` over agent-browser's verbs — the action-enum-over-N-tools rule, §3). This replaces the ~18 `browser_*` tools a per-action design would spawn, *and* the earlier `web_search`/`web_fetch` (both are just agent-browser actions — see Decision 4).
- Agent-invoked, no automatic behavior → exempt from the enforcement dial. Command `/pi-browser` (config). Log `[pi-browser]`.

## The real `agent-browser` surface (confirmed via `--help` + `skills get core --full`)

`agent-browser` is a rich CLI built for AI agents, with a version-matched skills system (`agent-browser skills get core --full` is the authoritative reference). Confirmed verbs: navigation `open`/`back`/`forward`/`reload`; senses `snapshot` (AX tree **with `@ref`s** — the primary AI sense; `-i` interactive, `-c` compact) and `read [url]` (agent-readable text — **this is "fetch"**); interaction `click`/`type`/`fill`/`press`/`hover`/`select`/`check`/`uncheck`/`scroll`/`wait`; capture `screenshot [path]`; introspection `get <what> [sel]`. A persistent daemon keeps the browser **session** alive across invocations, so sequential calls act on the same page. **Search:** no API command — the core skill's documented pattern is to open a search engine and read; DuckDuckGo takes the query in the URL, so `read https://duckduckgo.com/html/?q=<q>` returns results in one call. Targets are CSS selectors **or `@ref`** handles from a snapshot.

## Design Decisions

1. **One `browser` tool, `action` enum → agent-browser subcommand.** Curated verbs: `open`, `snapshot`, `read`, `search`, `click`, `type`, `fill`, `press`, `hover`, `select`, `check`, `uncheck`, `scroll`, `wait`, `screenshot`, `back`, `forward`, `reload`, `get`. Params are shared and action-gated (`url`, `query`, `ref`, `text`, `key`, `values`, `direction`, `amount`, `path`, `what`, `wait`), each described with which actions use it. Exotic verbs (`network`, `set`, `storage`, `mouse`, `eval`, `find`, `pdf`) are omitted from v1 — add enum members later, never new tools.
2. **Accessibility snapshot as the primary sense.** `snapshot` returns the AX tree with actionable `@ref`s; `click`/`type`/etc. act on those refs. `read` returns readable page text. `screenshot` only when a pixel view is genuinely needed.
3. **Session persistence is agent-browser's, not ours.** Its daemon keeps a live session across calls, so navigation/auth survive between tool invocations with no profile management by us. Config carries only the binary path (+ optional session name).
4. **Search & fetch are `browser` actions, not separate tools.** `action:"read"` (optionally with a `url`) is fetch. `action:"search"` is a one-call convenience = `read https://www.bing.com/search?q=<query>` (keyless, no provider config). **Engine choice (tested live):** DuckDuckGo bot-blocks the headless browser (both its no-JS `html`/`lite` endpoints — GET returns only the region selector — and its JS site, which errors); **Bing** returns results to a plain GET+read. This dissolves the old `web_search`/`web_fetch` split — one tool, no API keys.
5. **Deferred activation (optional).** The `browser` action enum is large; consider Pi's deferred/progressive tool loading so it stays out of the prompt until a web task begins. Flag, not required for v1.

### Open items for the human
- Whether to pin a `--session` name for isolation (v1 uses agent-browser's default session). Search engine choice (v1 = DuckDuckGo html endpoint, keyless).

## File Structure & Responsibilities

| File | Responsibility |
|---|---|
| `src/browser.ts` | `browserArgv` (pure action→argv) + `runBrowser` (injectable exec → agent-browser stdout) |
| `src/config.ts` | `BrowserConfig` — the `agent-browser` binary path (+ optional session) |
| `src/tools.ts` | the one `browser` tool (action dispatch) |
| `src/command.ts` | `/pi-browser` config |
| `index.ts` | factory wiring |
| `test/*.test.ts` | action→argv construction (table-driven, pure); `runBrowser` via fake exec |

## Interfaces / Contracts

```typescript
// browser.ts — action→argv CONFIRMED against agent-browser --help
type BrowserAction =
  | "open" | "snapshot" | "read" | "search" | "click" | "type" | "fill" | "press"
  | "hover" | "select" | "check" | "uncheck" | "scroll" | "wait" | "screenshot"
  | "back" | "forward" | "reload" | "get";                  // StringEnum in the tool schema
interface BrowserArgs {
  url?: string; query?: string; ref?: string; text?: string; key?: string;
  values?: string[]; direction?: "up" | "down" | "left" | "right"; amount?: number;
  path?: string; what?: string; wait?: string;              // `wait` = a selector or ms
}
function browserArgv(action: BrowserAction, args: BrowserArgs): string[];   // pure — the tested unit; throws on a missing required arg
function runBrowser(action: BrowserAction, args: BrowserArgs, cfg: BrowserConfig, exec: ExecFn): Promise<string>;

// config.ts
interface BrowserConfig { binPath: string; session?: string; }

// tool: browser({ action, ...BrowserArgs }) → agent-browser stdout as tool text
//   search → read https://duckduckgo.com/html/?q=<encoded query>
```

## Build Sequence

- [ ] **1 · Scaffold** — per house-style. Accept: `bun test` runs.
- [ ] **2 · `browserArgv`** — Accept (table-driven pure tests): each action builds the confirmed agent-browser argv (`open <url>`, `read`/`read <url>`, `search`→`read <ddg-url>`, `snapshot -i`, `click <ref>`, `type <ref> <text>`, `get <what> [sel]`, `scroll <dir> [px]`, `screenshot [path]`, bare `back`/`forward`/`reload`); a missing required arg throws.
- [ ] **3 · `runBrowser`** — Accept: runs `binPath` + argv via a fake exec, returns stdout; a non-zero exit throws with stderr; `binPath` defaults to `"agent-browser"`.
- [ ] **4 · Tool + config** — Accept: `browser` registered with the `action` `StringEnum` + described params; unknown/missing required args surface as thrown tool errors; `/pi-browser` sets `binPath`/`session`. Manual smoke covered in step 5.
- [ ] **5 · Live smoke (tmux)** — `browser open` a page, `browser snapshot`, `browser search "..."`, `browser read`; confirm real output. Degrade with a clear error if `agent-browser` is absent.

## Test Strategy

Everything unit-testable without a live browser: `browserArgv` is a pure table-driven unit (the core); `runBrowser` via a fake exec asserting the argv and parsing canned stdout, plus the non-zero-exit error path. The only live check is a real `agent-browser` open/snapshot/search in the tmux smoke.

## Risks / Notes

- The layer hinges on `agent-browser`'s real CLI — the argv mapping is confirmed against `--help`; keep `browserArgv` the single place any flag lives.
- `agent-browser` must be installed and on PATH (or `binPath` configured); degrade with a clear `[pi-browser]` error if absent.
- Auth'd browsing relies on agent-browser's persistent session — keep credentials/cookies out of logs and git.
- `search` uses Bing's results page (DuckDuckGo blocks headless automation, verified live); it can change or rate-limit. If it gets flaky, the agent can fall back to `open`+`snapshot`+`fill`+`press` on any engine, or a real search API is a clean future config add.
- The `action` enum grows by adding members, never new tools.
