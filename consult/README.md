# pi-consult

A **second opinion for the agent** — a [Pi](https://pi.dev) extension that lets the model ask a different, independent model for read-only advice on a hard problem, plan, or review, without leaving the session.

Part of the [`pi-*` suite](https://github.com/kazzarahw/pi-shared).

## What it does

Registers one `consult` tool that shells out to the `claude` CLI (`claude -p <prompt> --model <model>`) and returns the advice as tool output. It uses your Claude **subscription** via the CLI — no API key, and no changes to the current session's files or state. It's deliberately distinct from [pi-spawn](https://github.com/kazzarahw/pi-spawn) (which runs nested `pi` subprocesses): consult is a *different* model for a *second perspective*.

## Tool

```
consult({ prompt, model? })
```
- **`prompt`** — the question/context to send.
- **`model`** — optional Claude model/alias (`opus`, `sonnet`, `haiku`, …); defaults to the configured model.

Returns the model's advice as text and emits `consult:answered { model, topic }`.

## Configure

`/pi-consult` opens a settings panel (or `/pi-consult <model>` sets the default directly). Persisted to `~/.pi/agent/pi-consult.json`:

| Setting | Default | Meaning |
|---|---|---|
| `defaultModel` | `opus` | model used when the tool call omits one |
| `allowedModels` | `opus, sonnet, haiku` | completions offered by the command (not enforced) |

## Install

```sh
pi install git:github.com/kazzarahw/pi-consult
```

Requires the `claude` CLI on `PATH` and authenticated. AGPL-3.0.
