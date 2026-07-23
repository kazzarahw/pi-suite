# pi-browser — Build Spec

> Design/implementation spec. Decisions, responsibilities, interfaces, build
> order, acceptance criteria. No function bodies.

**Goal:** One coherent, house-style web surface — browser automation (wrapping the `agent-browser` CLI) plus web search and URL fetch — collapsed into **three tools**, not one-per-action.

**Architecture:** Thin wrappers. A single `browser` tool dispatches to `agent-browser` subcommands via an `action` enum (injectable exec); `web_search` calls a provider API; `web_fetch` does HTTP GET + readability extraction. No engine of our own — the value is standardization and native fit.

**Tech Stack:** TypeScript/ESM, Bun + `bun test`, `node:child_process` for `agent-browser`, `fetch` for web, `@earendil-works/pi-*` peers.

## Global Constraints

See `pi-shared/HOUSE-STYLE.md`. Application:
- **Three tools:** `browser` (one tool, `action` `StringEnum` over agent-browser's verbs — the action-enum-over-N-tools rule, §3), `web_search`, `web_fetch`. This replaces the ~18 `browser_*` tools a per-action design would spawn.
- Agent-invoked, no automatic behavior → exempt from the enforcement dial. Command `/pi-browser` (config). Log `[pi-browser]`.

## The real `agent-browser` surface (confirmed via `--help`)

`agent-browser` is a rich CLI *built for AI agents* and ships a version-matched skills system — **`agent-browser skills get core --full`** is the authoritative reference (workflow patterns, ref/selector usage, examples), better than guessing from flags. Verbs seen: navigation `open` / `back` / `forward` / `reload`; senses `snapshot` (accessibility tree **with refs** — the primary AI sense) and `read` (agent-readable text); interaction `click` / `dblclick` / `type` / `fill` / `press` / `keyboard` / `hover` / `focus` / `check` / `uncheck` / `select` / `drag` / `upload` / `download` / `scroll` / `scrollintoview` / `wait`; capture `screenshot` / `pdf`; introspection `get <what>` / `is <what>` / `find <locator>`; plus `eval`, `connect`, `close`, and `set` / `network` / `cookies` / `storage` (power-user). Interaction targets are CSS selectors **or `@ref`** handles from a `snapshot`.

## Design Decisions

1. **One `browser` tool, `action` enum → agent-browser subcommand.** Curated high-value verbs cover normal agent web work: `open`, `snapshot`, `read`, `click`, `type`, `fill`, `press`, `hover`, `select`, `check`, `uncheck`, `scroll`, `wait`, `screenshot`, `back`, `forward`, `reload`, `get`. Params are shared and action-gated (`url`, `ref`, `text`, `key`, `values`, `direction`, `amount`, `path`, `what`), each with a description saying which actions use it. Exotic verbs (`network`, `set`, `storage`, `mouse`, `eval`, `find`) are intentionally omitted from v1 — add to the enum later if a real need appears, without minting new tools.
2. **Accessibility snapshot as the primary sense.** `action:"snapshot"` returns agent-browser's AX tree with actionable `@ref`s; `click`/`type`/etc. act on those refs. `read` returns readable page text. `screenshot` is only for when a pixel view is genuinely needed.
3. **Session persistence is agent-browser's, not ours.** `agent-browser` keeps a live browser session across invocations (connect/close, cookies, storage, credentials), so authenticated logins survive between tool calls without us managing a profile. Config carries the `agent-browser` binary path and any provider/session options; keep credentials out of logs and git. (Confirm the exact persistence/profile flag via `skills get core --full` at build.)
4. **Web split from browser.** `web_search({ query })` hits a configured provider API (provider + key ref in config); `web_fetch({ url })` does HTTP GET + readability extraction to text. Stateless, independent of the browser session. `web_fetch` (fast, no browser) vs `browser action:"read"` (full browser, JS-rendered, authenticated) is the documented trade.
5. **Deferred activation (optional).** Even at three tools, the `browser` action enum is large; consider Pi's deferred/progressive tool loading (the `kimi-deferred-tools` pattern) so it stays out of the prompt until a web task begins. Flag, not required for v1.

### Open items for the human — resolve in build step 2
- Confirm the curated `action` set and each action's argv against `agent-browser skills get core --full` (and subcommand `--help`). Search provider + API-key reference. Path to the `agent-browser` binary; any session-persistence flag.

## File Structure & Responsibilities

| File | Responsibility |
|---|---|
| `src/browser.ts` | `runBrowser(action, args)` — maps the `action` enum to an `agent-browser` argv (injectable exec), parses output |
| `src/web.ts` | `webSearch` (provider API) + `webFetch` (HTTP + extract), injectable fetch |
| `src/extract.ts` | pure HTML → readable text |
| `src/config.ts` | `agent-browser` path/options, search provider, key ref |
| `src/tools.ts` | `browser` (action dispatch) + `web_search` + `web_fetch` |
| `src/command.ts` | `/pi-browser` config |
| `index.ts` | factory wiring |
| `test/*.test.ts` | action→argv construction (fake exec), search/fetch parsing (fake fetch), extract |

## Interfaces / Contracts

```typescript
// browser.ts — exec injectable; action→argv CONFIRMED against agent-browser in step 2
type BrowserAction =
  | "open" | "snapshot" | "read" | "click" | "type" | "fill" | "press" | "hover"
  | "select" | "check" | "uncheck" | "scroll" | "wait" | "screenshot"
  | "back" | "forward" | "reload" | "get";                 // StringEnum in the tool schema
interface BrowserArgs {
  url?: string; ref?: string; text?: string; key?: string;
  values?: string[]; direction?: "up" | "down" | "left" | "right"; amount?: number;
  path?: string; what?: string;                            // `what` for action:"get" (text/value/attr/url/title)
}
function browserArgv(action: BrowserAction, args: BrowserArgs): string[];   // pure — the tested unit
function runBrowser(action: BrowserAction, args: BrowserArgs, cfg: BrowserConfig, exec: ExecFn): Promise<string>;

// web.ts
interface SearchResult { title: string; url: string; snippet: string; }
function webSearch(query: string, cfg: WebConfig, fetchFn?: typeof fetch): Promise<SearchResult[]>;
function webFetch(url: string, fetchFn?: typeof fetch): Promise<string>;   // extracted text

// extract.ts (pure)
function htmlToText(html: string): string;

// config.ts
interface BrowserConfig { binPath: string; }
interface WebConfig { provider: "brave" | "deepseek" | string; apiKeyRef: string; }

// tools: browser({ action, ...BrowserArgs }), web_search({ query }), web_fetch({ url })
```

## Build Sequence

- [ ] **1 · Scaffold** — per house-style. Accept: `bun test` runs.
- [ ] **2 · Confirm `agent-browser`** — run `agent-browser skills get core --full` (and subcommand `--help`); record the confirmed `action`→argv/output mapping into the Interfaces block. Accept: mapping documented; no guessed flags remain; the curated `action` set is final.
- [ ] **3 · `browserArgv` + `runBrowser`** — Accept: `browserArgv` builds the confirmed argv per action (assert via table-driven pure tests); `runBrowser` runs it via a fake exec and parses output (`snapshot` → AX text with refs; `get` → the requested value); errors surface as thrown tool errors.
- [ ] **4 · `htmlToText`** — Accept: strips scripts/styles/markup from a fixture page to readable text; collapses whitespace.
- [ ] **5 · Web tools** — Accept: `web_search` builds the provider request and parses results to `SearchResult[]` (fake fetch); `web_fetch` GETs + `htmlToText` (fake fetch).
- [ ] **6 · Tools + config** — Accept: `browser` (action `StringEnum`), `web_search`, `web_fetch` registered with house-style params; `/pi-browser` sets provider/key/binPath; manual smoke: `browser open` a page, `browser snapshot`, `browser click` a ref, `web_search` a query.

## Test Strategy

Everything testable without a live browser or network: `browserArgv` is a pure table-driven unit (the core), `runBrowser` via a fake exec asserting argv + parsing canned output; `web.ts` via a fake `fetch`; `htmlToText` pure. The only manual smoke is a real `agent-browser` open/snapshot/click + a real search call.

## Risks / Notes

- The whole browser layer hinges on `agent-browser`'s real CLI — step 2 is a hard gate; do not code `browser.ts` from an assumed mapping. The skills system makes this cheap and authoritative.
- `agent-browser` must be installed and on PATH (or `binPath` configured); degrade with a clear error if absent.
- Auth'd browsing relies on agent-browser's persistent session — keep credentials/cookies out of logs and git.
- The `action` enum will grow as needs surface; that is by design (add enum members, never new tools). If the enum's shared-param schema gets confusing, split only the highest-frequency verbs (`open`, `snapshot`) into their own tools as a last resort.
