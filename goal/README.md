# pi-goal

The **session's north-star** for [Pi](https://pi.dev) — one stated objective, kept in the agent's context on every turn so long work does not drift off the thing it was for.

Part of the [pi-suite](../README.md).

## What it does

[`pi-todo`](../todo) tracks *what to do next*. pi-goal holds the level above it: *what all of it is for*. In a long session the todo list stays internally consistent while collectively wandering away from the request that started it, because the request itself scrolled out of the window turns ago.

So the objective is injected as **standing context** on every LLM call — not re-injected at session start and then forgotten — and rendered as a widget above the editor (`▸` active, `✓` met). It is persisted into the session, so it survives `/fork` and compaction, and it dies with the session: an objective is a property of the work in flight, not of the repository.

## Tool

```
goal_set({ objective, criteria?, status? })
```

Replaces the objective wholesale. `status` is `active` (default) or `met`. Restating the *same* objective carries omitted fields forward, so marking a goal met need not repeat the criteria, and amending the criteria cannot silently reopen a goal already met. Reopening one is still possible — it just has to be said, with an explicit `status: "active"`.

The turn count and todo tally shown in the widget are deliberately **not** in the injected block: it sits at message index 0 of every call, so anything that ticks over would invalidate the provider's conversation-history prompt cache on each one.

Emits `goal:set { objective, criteria? }` on every write, and `goal:met { objective }` once, when the objective transitions to met.

If [`pi-todo`](../todo) — or anything else publishing `todo:updated` — is running, its progress folds into the readout (`3 turns · 2 of 5 todos done`). That is an *optional enhancement*, not a dependency: there is no import between the two, only the bus, and with pi-todo disabled, replaced, or absent the fragment simply never appears.

## Automatic behavior (hooks)

- **Context injection** on `context` — the objective rides along on every call. A met objective stops being injected; it is finished, and repeating it costs context for nothing.
- **Restore + widget** on `session_start` / `session_compact`.
- **Settle nudge** on `agent_settled`, per `mode` (below). Guarded on `hasUI`, so it never stalls `pi -p`.

## Configure

`/pi-goal` opens a settings panel (or `/pi-goal <off|notify|block>`). Persisted to `~/.pi/agent/pi-goal.json`:

| `mode` | Behavior |
|---|---|
| `off` | tool and widget only — no injection, no nudge |
| `notify` *(default)* | inject the objective every call, plus a passive reminder on the next turn |
| `block` | auto-continues the turn while the objective is unmet, up to the quota below |

| Setting | Default | |
|---|---|---|
| `nudges` | `2` | How many times pi-goal may nudge about **one** objective — reminders in `notify`, auto-continues in `block`. Setting a new objective refills it. |

It is a quota per objective rather than a no-progress detector, and that is deliberate. pi-todo can tell whether a nudge achieved anything because its state *is* the work: the list moves as the work moves. pi-goal's state is a declaration that changes only when the agent calls `goal_set`, so there is nothing here that progress-tracking could honestly measure — a quota is the shape that actually terminates. The quota also covers `notify` because each reminder becomes a permanent message in the transcript, on top of the standing injection already saying the same thing.

`/pi-goal clear` forgets the objective. Setting one is deliberately **not** a command — that is the agent's job via `goal_set`, and `/pi-goal` configures.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
