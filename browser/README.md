# pi-browser

**The web in one tool** — a [Pi](https://pi.dev) extension wrapping the [`agent-browser`](https://www.npmjs.com/package/agent-browser) CLI: search, fetch, snapshot, and interact with real pages, over a persistent browser session. Keyless — no search API, no provider config.

Part of the [pi-suite](../README.md).

## What it does

Registers one `browser` tool whose `action` selects an `agent-browser` verb, so search/fetch/automation are all one tight surface instead of many tools. A persistent daemon keeps the browser **session** alive across calls, so sequential actions act on the same page.

## Tool

```
browser({ action, url?, query?, ref?, text?, key?, values?, direction?, amount?, path?, what?, wait? })
```

Key actions:
- **`search`** — look something up (keyless). Tries `html.duckduckgo.com/html` first, falls back to Bing, and detects bot-walls to fall through.
- **`open`** + **`snapshot`** — load a page and get an accessibility tree with `@ref` handles (the primary AI sense).
- **`read`** — a page's text (optionally at a `url` — this is "fetch").
- **`click` / `type` / `fill` / `press` / `hover` / `select` / `check` / `scroll`** — interact, targeting an `@ref` or a CSS selector.
- **`back` / `forward` / `reload` / `wait` / `screenshot` / `get`** — navigation, capture, introspection.

## Configure

`/pi-browser` opens a settings panel. Persisted to `~/.pi/agent/pi-browser.json`:

| Setting | Default | Meaning |
|---|---|---|
| `binPath` | `agent-browser` | the agent-browser binary |
| `session` | *(default)* | agent-browser session name, for isolation |

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

Requires the `agent-browser` CLI on `PATH`. AGPL-3.0.
