# pi-memory

**Persistent, write-back memory** — a [Pi](https://pi.dev) extension that lets the agent record durable learnings and recall them across sessions, with a progressive-disclosure index always in context.

Part of the [pi-suite](../README.md).

## What it does

Memories are markdown files (frontmatter + body) stored **global** (`~/.pi/agent/memory/`) or **project** (`<cwd>/.pi/memory/`), each dir with an auto-generated `INDEX.md`. The index (names + descriptions only) is injected into every LLM call; full bodies load on demand via recall. A secret scanner refuses to store obvious credentials.

## Tools

```
memory_recall({ query? , name? })          // full text by keyword or exact name
memory_write({ name, description, content, type, scope })
```
- **`type`** — `user | feedback | project | reference`.
- **`scope`** — `global` (all projects) or `project` (this repo). A `project` write creates
  `<cwd>/.pi/memory/` inside your repository; the first write that creates it says so, since
  meeting it later as an unexplained untracked directory is not the same as being told.
- `memory_write` **refuses content containing likely secrets** (API keys, tokens, private keys).

Emits `memory:wrote { keys }` / `memory:recalled { keys }`.

## Automatic behavior (hooks)

- **Index injection** on the `context` hook — the `<pi-memory>` index rides every call (when `mode ≠ off`).
- **Auto-capture** on `verify:failed` — records a gotcha memory. Off by default (naive capture is noisy).

  This is an *optional enhancement*, not a dependency. pi-memory subscribes to the event; it does not care who publishes it. [pi-lens](../lens) does today, but with lens disabled, replaced, or not installed, auto-capture simply never fires and everything else works unchanged. There is no import between the two — only the bus.

## Configure

`/pi-memory` opens a settings panel (or `/pi-memory mode <m>` / `autocapture on|off` / `delete <name>`). Persisted to `~/.pi/agent/pi-memory.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `notify` | `off` disables index injection + auto-capture |
| `autoCapture` | `false` | capture a gotcha on `verify:failed` |
| `recallLimit` | `3` | max bodies a keyword recall returns |
| `indexLimit` | `50` | max entries listed in the injected index |

`recallLimit` and `indexLimit` bound different things. `recallLimit` caps one deliberate
lookup; `indexLimit` caps a block that rides on **every** LLM call, which is why it needs
a bound at all — the index used to be an unbounded map over the whole store, so a few
hundred memories bought a few hundred lines of prompt on every call for the rest of the
session. When it is capped the block says how many it left out, and
`memory_recall(query)` still searches all of them.

## Project trust

Memories under `<cwd>/.pi/memory` are **repository content**, and the index is prepended
to every LLM call — so an untrusted project does not get to write the agent's standing
context. When [`ctx.isProjectTrusted()`](https://pi.dev) is false, the project scope is
skipped for both the injection and `memory_recall`; global memories are unaffected.

Pi's own trust model gates the project resources Pi knows about — `.pi/settings.json`,
`.pi/extensions`, `.pi/skills`, and friends. It has never heard of `.pi/memory`, which
this extension invented, so the gate has to live here. [`pi-lens`](../lens) draws the same
line around an autodetected verify command, and [`pi-spawn`](../spawn) around project
agent definitions.

This is not a claim to prevent prompt injection; Pi is explicit that repository content is
expected local-agent risk. It is the narrower, preventable case.

`/pi-memory` itself is deliberately **not** gated: trust governs what reaches the model,
not what the user can see of their own files, and `delete <name>` has to be able to name a
project memory in a project you have not trusted.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
