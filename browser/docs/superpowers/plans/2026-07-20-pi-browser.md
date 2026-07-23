# pi-browser — Build Spec

> Design/implementation spec. Decisions, responsibilities, interfaces, build
> order, acceptance criteria. No function bodies.

**Goal:** One coherent, house-style tool surface for the web — browser automation (wrapping the `agent-browser` CLI) plus web search and URL fetch — with names/args standardized to match the rest of the suite.

**Architecture:** Thin wrappers. Browser tools shell out to the `agent-browser` CLI (injectable exec); web tools call a search provider API and an HTTP-fetch-plus-extract (injectable fetch). No engine of our own — the value is standardization and native fit, not reimplementing a browser.

**Tech Stack:** TypeScript/ESM, Bun + `bun test`, `node:child_process` for `agent-browser`, `fetch` for web, `@earendil-works/pi-*` peers.

## Global Constraints

See `pi-shared/HOUSE-STYLE.md`. Application:
- Tools `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`, `web_search`, `web_fetch`.
- Agent-invoked, no automatic behavior → exempt from the enforcement dial. Command `/pi-browser` (config). Log `[pi-browser]`.

## Design Decisions

1. **Wrap `agent-browser` for browser control** rather than embedding Playwright — matches `pi-agent-browser-native`'s approach, keeps us thin, and lets us standardize the tool names. Each `browser_*` tool maps to an `agent-browser` subcommand via injectable exec.
2. **Accessibility snapshot as the primary sense.** `browser_snapshot()` returns `agent-browser`'s structured/AX snapshot (refs the agent can act on) rather than raw HTML or a screenshot — cheaper and more reliable for agents. `browser_click`/`browser_type` act on those refs. `browser_screenshot` is for when a pixel view is actually needed.
3. **Persistent profile** for authenticated apps — a configured profile dir passed to `agent-browser`, so logged-in sessions survive.
4. **Web split from browser.** `web_search({ query })` hits a configured provider API (Brave/DeepSeek/etc. — provider + key ref in config); `web_fetch({ url })` does HTTP GET + readability extraction to text. These are stateless and independent of the browser session.
5. **Deferred activation (optional).** The browser sub-tools are many; consider Pi's deferred/progressive tool loading (the `kimi-deferred-tools` pattern) so they stay out of the prompt until a browser task begins. Flag, not required for v1.

### Open items for the human — resolve in build step 2
- **`agent-browser`'s exact CLI surface** (subcommands, flags, output format). The first build step is `agent-browser --help`; the tool→subcommand mapping below is the *intended* shape, to be confirmed against the real CLI.
- Search provider + API-key reference. Browser profile dir. Path to the `agent-browser` binary.

## File Structure & Responsibilities

| File | Responsibility |
|---|---|
| `src/browser.ts` | `Browser` wrapper over `agent-browser` subcommands (injectable exec) |
| `src/web.ts` | `webSearch` (provider API) + `webFetch` (HTTP + extract), injectable fetch |
| `src/extract.ts` | pure HTML → readable text |
| `src/config.ts` | provider, key ref, profile dir, `agent-browser` path |
| `src/tools.ts` | `browser_*` + `web_*` tool definitions |
| `src/command.ts` | `/pi-browser` config |
| `index.ts` | factory wiring |
| `test/*.test.ts` | browser argv construction (fake exec), search/fetch parsing (fake fetch), extract |

## Interfaces / Contracts

```typescript
// browser.ts — exec injectable; argv shapes CONFIRMED against `agent-browser --help` in step 2
interface Browser {
  navigate(url: string): Promise<string>;         // returns page snapshot/title
  snapshot(): Promise<string>;                     // AX/structured snapshot with actionable refs
  click(ref: string): Promise<void>;
  type(ref: string, text: string): Promise<void>;
  screenshot(path?: string): Promise<string>;      // returns saved path
}
function createBrowser(cfg: BrowserConfig, exec: ExecFn): Browser;

// web.ts
interface SearchResult { title: string; url: string; snippet: string; }
function webSearch(query: string, cfg: WebConfig, fetchFn?: typeof fetch): Promise<SearchResult[]>;
function webFetch(url: string, fetchFn?: typeof fetch): Promise<string>;   // extracted text

// extract.ts (pure)
function htmlToText(html: string): string;

// config.ts
interface BrowserConfig { binPath: string; profileDir: string; }
interface WebConfig { provider: "brave" | "deepseek" | string; apiKeyRef: string; }

// tools: browser_navigate/snapshot/click/type/screenshot, web_search({query}), web_fetch({url})
```

## Build Sequence

- [ ] **1 · Scaffold** — per house-style. Accept: `bun test` runs.
- [ ] **2 · Confirm `agent-browser` CLI** — run `agent-browser --help` (and subcommand help); record the real subcommand/flag/output mapping into this spec's Interfaces block before coding `browser.ts`. Accept: mapping documented; no guessed flags remain.
- [ ] **3 · `Browser` wrapper** — Accept: each method builds the confirmed argv (assert via fake exec) and parses the subcommand output into the return type; `snapshot` returns the AX text; errors surface as thrown tool errors.
- [ ] **4 · `htmlToText`** — Accept: strips scripts/styles/markup from a fixture page to readable text; collapses whitespace.
- [ ] **5 · Web tools** — Accept: `web_search` builds the provider request and parses results to `SearchResult[]` (fake fetch); `web_fetch` GETs + `htmlToText` (fake fetch).
- [ ] **6 · Tools + config** — Accept: all seven tools registered with house-style names/params; `/pi-browser` sets provider/key/profile/binPath; manual smoke: `browser_navigate` a page, `browser_snapshot`, `web_search` a query.

## Test Strategy

Everything testable without a live browser or network: `browser.ts` via a fake exec asserting argv + parsing canned output; `web.ts` via a fake `fetch` returning fixture payloads; `htmlToText` pure. The only manual smoke is a real `agent-browser` navigate + a real search call.

## Risks / Notes

- The whole browser layer hinges on `agent-browser`'s real CLI — step 2 is a hard gate; do not code `browser.ts` from the assumed mapping.
- `agent-browser` must be installed and on PATH (or `binPath` configured); degrade with a clear error if absent.
- Auth'd browsing via persistent profiles handles credentials — keep the profile dir out of any logs and out of git.
- If the sub-tool count bloats the prompt, adopt deferred activation (Decision 5).
