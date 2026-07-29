# pi-memory

**Persistent, write-back memory** — a [Pi](https://pi.dev) extension that lets the agent record durable learnings and recall them across sessions, with a progressive-disclosure index always in context.

Part of the [pi-suite](../README.md).

## What it does

Memories are markdown files (frontmatter + body) stored **global** (`~/.pi/agent/memory/`) or **project** (`<cwd>/.pi/memory/`), each dir with an auto-generated `INDEX.md`. The index (names + descriptions only) is injected into every LLM call; full bodies load on demand via recall. A secret scanner refuses to store obvious credentials.

## Tools

One `memory` tool, two actions:

```
memory({ action: "recall", query? , name? })   // full text by keyword or exact name
memory({ action: "write", name, description, content, type, scope })
```
- **`type`** — `user | feedback | project | reference`.
- **`scope`** — `global` (all projects) or `project` (this repo). A `project` write creates
  `<cwd>/.pi/memory/` inside your repository; the first write that creates it says so, since
  meeting it later as an unexplained untracked directory is not the same as being told.
- `write` **refuses content containing likely secrets** (API keys, tokens, private keys).
- `write`'s fields are required at call time rather than by the schema — the two actions
  need disjoint parameters, so a missing one comes back as an error naming all of them.

Emits `memory:wrote { keys }` / `memory:recalled { keys }`.

### When the agent is told to write one

`write`'s description names **events**, not a judgement: the user corrects you or says how
they want you to work; you work out something about the project that the code, tests, and
git history do not already say and that cost you effort to find; the user tells you
something about themselves or their setup. Plus the floor — don't record what the repository
already records, and don't record what is only true of the task in front of you.

This is deliberate rather than verbose. The index injection is a table of contents of what
is **already** stored — nothing in it, or anywhere else, tells an agent to store something
new. So the description is the only surface that reaches an agent about writing, and it also
has to overcome the fact that nobody asked for a memory. The previous wording asked it to
"persist a durable learning", which is a classification problem rather than something you
can notice happening, and across nine dogfooding sessions it produced zero writes.

`recall` is unchanged. Those sessions show zero recalls too, but the store held only two
test fixtures described as "body" and "test body content" — nothing whose description could
look relevant to any real task — so that number says nothing about its trigger.

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
`memory(action: "recall", query)` still searches all of them.

## Project trust

Memories under `<cwd>/.pi/memory` are **repository content**, and the index is prepended
to every LLM call — so an untrusted project does not get to write the agent's standing
context. When [`ctx.isProjectTrusted()`](https://pi.dev) is false, the project scope is
skipped for both the injection and `recall`; global memories are unaffected.

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
