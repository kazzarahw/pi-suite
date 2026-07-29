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
| `mode`        | `notify`    | Enforcement dial                                         |
| `defaultChat` | _(not set)_ | Default chat ID/username for actions that omit `chat_id` |

## Automatic behavior

None initially — all actions are agent-initiated. The `telegram:message` event is declared for cross-extension subscribers, but nothing emits it yet (planned for a future polling hook).

## Events

Emitted on the cross-extension bus:

- **`telegram:message`** — `{ chatId, from, text, date }`

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
