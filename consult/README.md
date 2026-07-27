# pi-consult

A **second opinion for the agent** — a [Pi](https://pi.dev) extension that lets the model ask a different, independent model for read-only advice on a hard problem, plan, or review, without leaving the session.

Part of the [pi-suite](../README.md).

## What it does

Registers one `consult` tool that shells out to the `claude` CLI (`claude -p <prompt> --model <model>`) and returns the advice as tool output. It uses your Claude **subscription** via the CLI — no API key, and no changes to the current session's files or state. It's deliberately distinct from [spawn](../spawn) (which runs nested `pi` subprocesses): consult is a *different* model for a *second perspective*.

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
| `allowedModels` | `opus, sonnet, haiku` | presets offered by the command and the panel — **not** an allowlist |

`allowedModels` is a preset list, not a gate: `claude` accepts model names this suite has
no business enumerating, so an unlisted one still runs. What the panel does do is *say* when
the configured default is not one of them, and when `claude` is not on `PATH` at all — a
stale `defaultModel` otherwise fails every call with nothing connecting the failure to a
setting you forgot you had. The tool checks for the CLI before spawning it, so a missing
install reports as a missing install rather than as whatever a failed spawn puts on stderr.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

Requires the `claude` CLI on `PATH` and authenticated. AGPL-3.0.
