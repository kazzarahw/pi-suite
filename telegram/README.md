# pi-telegram

**Send and receive Telegram messages** — a [Pi](https://pi.dev) extension wrapping the Telegram Bot API: post messages, read recent ones, list conversations, and run quick chat round-trips.

Part of the [pi-suite](../README.md).

## What it does

Registers one `telegram` tool whose `action` selects a Telegram verb, so messaging is one tight surface instead of many tools. Uses the Bot API directly over HTTPS — no external CLI or daemon required.

## Tool

```
telegram({ action, chat_id?, text?, limit? })
```

Actions:

- **`send`** — send a text message to a chat.
- **`read`** — fetch recent messages from a chat.
- **`list`** — list recent conversations.
- **`chat`** — send a message and read the reply in one call.

### Required config

You need a **Telegram Bot Token** from [@BotFather](https://t.me/BotFather) to use this extension. Set it via:

```
/pi-telegram token <your-bot-token>
```

## Configure

`/pi-telegram` opens a settings panel (or `/pi-telegram <field> <value>`). Persisted to `~/.pi/agent/pi-telegram.json`:

| Setting       | Default     | Meaning                                                  |
| ------------- | ----------- | -------------------------------------------------------- |
| `token`       | _(not set)_ | Telegram Bot API token (from BotFather)                  |
| `defaultChat` | _(not set)_ | Default chat ID/username for actions that omit `chat_id` |

There is no `mode`. The enforcement dial belongs to the extensions that act on their own initiative; this one speaks only when the agent calls the tool, so there is nothing to turn down — the same reason pi-browser and pi-spawn have none.

## Automatic behavior

None. Every action is agent-initiated: pi-telegram registers no hooks and subscribes to nothing, so it never sends a message you did not ask for. `read` and `list` are polls of `getUpdates`, not a background listener.

## Events

None, in either direction. The bus vocabulary in `shared/events.ts` is closed and every name in it must have a publisher (`test/contract.test.ts`), so there is no reserved-but-unemitted `telegram:*` event to bind to. A future polling hook would add one at the point it starts emitting it.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
