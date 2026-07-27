# pi-goal

The **session's north-star** for [Pi](https://pi.dev) — one stated objective, kept in the agent's context on every turn so long work does not drift off the thing it was for.

Part of the [pi-suite](../README.md).

## What it does

[`pi-todo`](../todo) tracks *what to do next*. pi-goal holds the level above it: *what all of it is for*. In a long session the todo list stays internally consistent while collectively wandering away from the request that started it, because the request itself scrolled out of the window turns ago.

So the objective is injected as **standing context** on every LLM call — not re-injected at session start and then forgotten — and rendered as a widget above the editor (`▸` active, `✓` met). It is persisted into the session, so it survives `/fork` and compaction, and it dies with the session: an objective is a property of the work in flight, not of the repository.

## Tool

```
goal({ objective, criteria?, status? })
```

Replaces the objective wholesale. `status` is `active` (default) or `met`. Restating the *same* objective carries omitted fields forward, so marking a goal met need not repeat the criteria, and amending the criteria cannot silently reopen a goal already met. Reopening one is still possible — it just has to be said, with an explicit `status: "active"`.

The turn count and todo tally shown in the widget are deliberately **not** in the injected block: it sits at message index 0 of every call, so anything that ticks over would invalidate the provider's conversation-history prompt cache on each one.

Emits `goal:set { objective, criteria? }` on every write, and `goal:met { objective }` once, when the objective transitions to met.

If [`pi-todo`](../todo) — or anything else publishing `todo:updated` — is running, its progress folds into the readout (`3 turns · 2 of 5 todos done`). Likewise [`pi-lens`](../lens): a `verify:passed` adds `verify ✓`, and the settle reminder names the command that passed and asks whether it satisfies the criteria. `criteria` is literally *how you will know the objective is met*, and a green test run is the strongest evidence available for that.

It never marks the objective **met**. Whether passing checks satisfy *this* objective is a judgement about intent, and it stays the agent's to make with `goal({ status: "met" })`; an extension that closed the goal off a green run would be answering a different question than the one the goal asked. A new objective clears the tick, so a run from before the goal changed cannot vouch for work that has not happened.

Both are *optional enhancements*, not dependencies: there is no import in either direction, only the bus, and with those extensions disabled, replaced, or absent the fragments simply never appear. Neither may reach the nudge **guard** — the settle signature is pi-goal's own state and nothing else, because a peer that could rearm the quota would mean installing pi-lens or pi-todo silently changed whether `block` mode terminates.

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

It is a quota per objective rather than a no-progress detector, and that is deliberate. pi-todo can tell whether a nudge achieved anything because its state *is* the work: the list moves as the work moves. pi-goal's state is a declaration that changes only when the agent calls `goal`, so there is nothing here that progress-tracking could honestly measure — a quota is the shape that actually terminates. The quota also covers `notify` because each reminder becomes a permanent message in the transcript, on top of the standing injection already saying the same thing.

`/pi-goal clear` forgets the objective. Setting one is deliberately **not** a command — that is the agent's job via `goal`, and `/pi-goal` configures.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
