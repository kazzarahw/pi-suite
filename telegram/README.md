# pi-telegram

**Drive this session from Telegram** — a [Pi](https://pi.dev) extension that carries your
messages into the agent and its answers back out, over the Telegram Bot API.

Part of the [pi-suite](../README.md).

## What it does

Message your bot; the agent gets it as a turn and replies in the chat. That is the whole idea:
Pi is running on your machine, and you are not sitting in front of it.

It **registers no tool.** Everything it does is a hook, which is the rule `shared/surface.ts`
already states — automatic behavior is a hook, not a tool — and the reason pi-git registers none
either.

> **This replaced a tool, and the tool was the bug.** The previous version registered
> `telegram({ action })` with `send` / `read` / `list` / `chat`, so the *agent* could message
> Telegram. Nothing polled, because nothing was listening: `read` was a poll performed when the
> agent asked for one. So a bot token could be configured, a message sent to the bot, and the
> session would never hear about it — and this file described that as a feature, under
> *"Automatic behavior: None… it registers no hooks and subscribes to nothing."* A messaging
> extension exists to carry messages **in**. `pi.sendUserMessage` is the API that does it, and the
> tool version never called it.

## Setup

1. Get a bot token from [@BotFather](https://t.me/BotFather).
2. `/pi-telegram token <your-bot-token>` — or open `/pi-telegram` and type it into the **Bot
   token** row.
3. Message your bot. The terminal prints the chat id it came from.
4. `/pi-telegram chat <that-id>`.

Step 3 exists because **the authorised chat is not optional**. A Telegram bot answers anyone who
finds it, and what an inbound message reaches here is an agent with file and shell access. So the
bridge does not reply to whoever writes in: until a chat is authorised it listens, reports who
knocked, and delivers nothing. Pairing with the first sender would hand your session to whoever
found the bot first.

Messages from any other chat are ignored, and reported once per sender rather than once per
message.

## Configure

`/pi-telegram` opens a settings panel (or `/pi-telegram <field> <value>`). Persisted to
`~/.pi/agent/pi-telegram.json`, owner-only, because one of these is a credential:

| Setting   | Default      | Meaning                                                                  |
| --------- | ------------ | ------------------------------------------------------------------------ |
| `token`   | _(not set)_  | Bot API token. Never rendered — the panel shows `(set)` and nothing else. |
| `chat`    | _(not set)_  | The one chat allowed to drive this session, and where replies go.        |
| `bridge`  | `on`         | Listen at all. The off switch that leaves the token in place.            |
| `reply`   | `telegram`   | Which turns get an answer sent back: `telegram` \| `always` \| `off`.    |
| `approve` | `off`        | What to hold for approval first: `off` \| `writes` \| `all`.             |

A config written before this rewrite is read as-is: its `defaultChat` becomes `chat`.

### `reply` defaults to answering only what Telegram asked

Someone at the keyboard is already reading the reply, and mirroring every local answer to their
phone is notification spam that trains them to ignore the one that matters. `always` is for the
other real case — leaving something long running and wanting to be told it finished.

### There is no `mode`, and the reason inverted

This extension used to have no enforcement dial because it had no hooks: it spoke only when the
agent called its tool, so there was nothing to dial down. That argument was true of a tool and is
false of a bridge — this one polls on its own initiative, injects user messages, and can refuse a
tool call.

What replaced the dial is three switches, because they are three unrelated questions and
`off / notify / block` cannot express them: whether to listen (`bridge`), what to say back
(`reply`), and what to hold (`approve`).

## Approval

With `approve` on, a tool call is sent to your chat before it runs and waits for a reply. `writes`
covers `write`, `edit`, and `bash` — the `EDIT_TOOLS ∪ OPAQUE_WRITE_TOOLS` sets from
`shared/tool-input.ts`, composed rather than re-listed. `bash` matters most: pi-plan's edit gate
documents at length that it cannot see a write through `bash`, and an approval gate with the same
blind spot would ask about the careful half of the work and wave through `rm -rf`.

Only a clear `yes` approves. Anything else refuses, and the text is quoted back to the agent —
someone who replies *"not that file, do the other one"* is steering, not answering, and the useful
part of that is what they said.

**Two rules pull in opposite directions, and the line between them is who did not answer:**

- **Silence is never consent.** No reply before the deadline refuses.
- **A network problem never wedges a session.** If the question cannot be *sent* — no token, no
  authorised chat, bridge off, Telegram unreachable — the call goes ahead. The alternative is that
  a flat phone battery stops the person at the keyboard from working.

So this is a **convenience for operating remotely, not a security boundary**: Pi's own permission
system is still in front of every one of these calls. Same distinction
[`pi-plan`](../plan/README.md) draws about its edit gate being a discipline aid rather than an
enforcement guarantee.

`approve` is `off` by default. Turning it on is a statement that you intend to be reachable.

## Automatic behavior (hooks)

- **`session_start` / `session_shutdown`** — run one long-poll loop for the life of the session.
  Skipped when there is no UI: a one-shot `pi -p` run has no user to bridge to, and listening
  would hold the process open waiting for a message nobody will send.
- **`message_end` / `agent_settled`** — capture the final assistant text and relay it.
  `agent_settled` carries no payload, so the text has to be caught on the way past and held.
- **`tool_call`** — hold a call for approval, per `approve`.

Setting the token or turning the bridge on takes effect immediately, without a restart.

### One reader, on purpose

Every inbound message arrives through the one loop. That is what makes approval possible at all: a
second consumer of `getUpdates` would race the first for the reply, and whichever won would confirm
the offset and make the message vanish for the other. So asking a question does not read — it parks
a continuation the loop hands the next owner message to.

The loop uses a **confirming** offset (`last_update_id + 1`), which is the difference between
reading a chat and listening to one: each message is delivered exactly once. It starts *after*
whatever is already queued, because a bot's queue holds 24 hours of unretrieved messages and
replaying those into an agent as instructions is not what "start listening" should mean.

## Events

None, in either direction. The bus vocabulary in `shared/events.ts` is closed and every name in it
must have a publisher (`test/contract.test.ts`), so there is no reserved-but-unemitted `telegram:*`
event to bind to.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
