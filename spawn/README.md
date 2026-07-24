# pi-spawn

**Delegate to isolated subagents** — a [Pi](https://pi.dev) extension that hands tasks to specialized subagents, each running in a fresh `pi` process, one solo or many in parallel.

Part of the [`pi-*` suite](https://github.com/kazzarahw/pi-shared).

## What it does

Registers one `spawn` tool. Each delegated task runs as an isolated `pi --mode json -p --no-session` subprocess (its own context, its own tools), streaming live progress to a widget. Pass one task to run solo, or several to run in parallel under a concurrency cap (results return in input order). A `PI_SPAWN_DEPTH` guard prevents runaway nesting.

## Tool

```
spawn({ tasks: [{ agent, task }] })
```
- **`agent`** — a name from the roster (below).
- **`task`** — a fully self-contained description (the subagent has no other context).

Emits `spawn:started { agent }` / `spawn:finished { agent, summary? }`.

## Roster

Agents are markdown files (frontmatter: `name`, `description`, optional `model`, `tools`) discovered from **bundled** ∪ `~/.pi/agent/agents/` ∪ `<cwd>/.pi/agents/` (project wins). Bundled defaults:

| Agent | Role |
|---|---|
| `scout` | fast read-only reconnaissance (`read`/`grep`/`find`/`ls`) — reports a compressed summary |
| `worker` | full-capability implementer — edits files and verifies |
| `reviewer` | read-only critic — issues ranked by severity |

## Configure

`/pi-spawn` opens a settings panel (or `/pi-spawn model <name>` / `concurrency <n>`). Persisted to `~/.pi/agent/pi-spawn.json`:

| Setting | Default | Meaning |
|---|---|---|
| `defaultModel` | *(pi default)* | model for subagents whose def doesn't pin one |
| `concurrency` | `min(4, cores)` | max subagents in flight for a parallel spawn |

## Install

```sh
pi install git:github.com/kazzarahw/pi-spawn
```

AGPL-3.0.
