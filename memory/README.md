# pi-memory

**Persistent, write-back memory** — a [Pi](https://pi.dev) extension that lets the agent record durable learnings and recall them across sessions, with a progressive-disclosure index always in context.

Part of the [`pi-*` suite](https://github.com/kazzarahw/pi-shared).

## What it does

Memories are markdown files (frontmatter + body) stored **global** (`~/.pi/agent/memory/`) or **project** (`<cwd>/.pi/memory/`), each dir with an auto-generated `INDEX.md`. The index (names + descriptions only) is injected into every LLM call; full bodies load on demand via recall. A secret scanner refuses to store obvious credentials.

## Tools

```
memory_recall({ query? , name? })          // full text by keyword or exact name
memory_write({ name, description, content, type, scope })
```
- **`type`** — `user | feedback | project | reference`.
- **`scope`** — `global` (all projects) or `project` (this repo).
- `memory_write` **refuses content containing likely secrets** (API keys, tokens, private keys).

Emits `memory:wrote { keys }` / `memory:recalled { keys }`.

## Automatic behavior (hooks)

- **Index injection** on the `context` hook — the `<pi-memory>` index rides every call (when `mode ≠ off`).
- **Auto-capture** on `verify:failed` (from [pi-lens](https://github.com/kazzarahw/pi-lens)) — records a gotcha memory. Off by default (naive capture is noisy).

## Configure

`/pi-memory` opens a settings panel (or `/pi-memory mode <m>` / `autocapture on|off` / `delete <name>`). Persisted to `~/.pi/agent/pi-memory.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `notify` | `off` disables index injection + auto-capture |
| `autoCapture` | `false` | capture a gotcha on `verify:failed` |
| `recallLimit` | `3` | max bodies a keyword recall returns |

## Install

```sh
pi install git:github.com/kazzarahw/pi-memory
```

AGPL-3.0.
