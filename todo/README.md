# pi-todo

The **agent's task list** for [Pi](https://pi.dev) — a persistent, session-aware todo list rendered as a live widget, with a gentle nudge to keep multi-step work on track.

Part of the [`pi-*` suite](https://github.com/kazzarahw/pi-shared).

## What it does

Registers one `todo_write` tool (the Claude-Code full-list-replace model). The list renders as a widget above the editor (`▢` pending, `◐` in progress, `▣` done), is persisted into the session (so it survives `/fork` and compaction), and is re-injected into the agent's context on session start / after compaction. On settle, an optional nudge reminds the agent of open items.

## Tool

```
todo_write({ todos: [{ content, status, id? }] })
```
Send the **complete** list every call — it replaces the previous one. `status` is `pending | in_progress | done`. Emits `todo:updated { todos }` and `todo:task-complete { task }` for each item newly marked done.

## Automatic behavior (hooks)

- **Widget + context injection** on `session_start` / `session_compact`.
- **Settle nudge** on `agent_settled`, per `mode` (below). Guarded on `hasUI`, so it never stalls `pi -p`.

## Configure

`/pi-todo` opens a settings panel (or `/pi-todo <off|notify|block>`). Persisted to `~/.pi/agent/pi-todo.json`:

| `mode` | Behavior |
|---|---|
| `off` | widget only — no nudge |
| `notify` *(default)* | passive "keep going" reminder on the next turn |
| `block` | auto-continues the turn while items remain (guarded against no-progress loops) |

## Install

```sh
pi install git:github.com/kazzarahw/pi-todo
```

AGPL-3.0.
