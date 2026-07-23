# pi-shared

The hub of my **`pi-*` extension suite** for [Pi](https://pi.dev) — a small, self-consistent, *agent-facing* set of extensions built to cooperate natively rather than seven third-party extensions that happen to share a namespace. This package is both the written contract ([`HOUSE-STYLE.md`](./HOUSE-STYLE.md)) and the coded one (the shared types every extension depends on).

## The suite

| Extension | What it does | Agent tools |
|---|---|---|
| [pi-consult](https://github.com/kazzarahw/pi-consult) | A second opinion — run `claude --model` for read-only advice | `consult` |
| [pi-git](https://github.com/kazzarahw/pi-git) | Automatic per-turn checkpoints; rewinding a message reverts the files changed since it (via Pi's fork lifecycle) | *none — pure hooks* |
| [pi-lens](https://github.com/kazzarahw/pi-lens) | Real-time LSP + linter diagnostics injected after edits, plus an automatic test/verify pass | `lens` *(action enum)* |
| [pi-memory](https://github.com/kazzarahw/pi-memory) | Persistent write-back memory: record durable learnings, recall them across sessions | `memory_recall`, `memory_write` |
| [pi-spawn](https://github.com/kazzarahw/pi-spawn) | Delegate tasks to isolated subagents, one or many in parallel | `spawn` |
| [pi-todo](https://github.com/kazzarahw/pi-todo) | The agent's task list, rendered as a live widget | `todo_write` |
| [pi-browser](https://github.com/kazzarahw/pi-browser) | Browser automation (wrapping `agent-browser`) plus web search and fetch | `browser` *(action enum)*, `web_search`, `web_fetch` |

Nine tools total — a deliberately tight agent surface. See [`HOUSE-STYLE.md`](./HOUSE-STYLE.md) for why (automatic behavior is a hook not a tool; variant actions collapse behind one `action`-enum tool; the agent + harness are the consumers, not the user).

## Install the suite

Each extension is installed from its GitHub repo (AGPL-3.0, not published to npm):

```sh
for x in consult git lens memory spawn todo browser; do
  pi install git:github.com/kazzarahw/pi-$x
done
```

## This package

Types & constants shared across the suite — the single source of truth for the cross-extension contract, so a mismatch between two extensions is caught by the type-checker. Consumed as a **devDependency** (`"pi-shared": "github:kazzarahw/pi-shared"`); types-only, zero runtime dependencies.

| Module | Exports | House-style |
|---|---|---|
| `mode.ts` | `Mode`, `MODES`, `DEFAULT_MODE` — the universal `off \| notify \| block` enforcement dial | §7 |
| `events.ts` | `EventPayloads`, `EventName`, `EVENTS`, and shared payload types (`Diagnostic`, `TodoItem`, …) — the `domain:event` vocabulary | §4 |
| `tags.ts` | `TAG_PREFIX`, `tagName`, `injectionHeader`, `injectionBlock` — the `<pi-<name>>` context-injection format | §6 |

```ts
import { DEFAULT_MODE, EVENTS, injectionBlock, type Mode } from "pi-shared";
```

AGPL-3.0.
