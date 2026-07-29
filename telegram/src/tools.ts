import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TelegramConfig } from "./config.ts";
import {
  sendMessage,
  readMessages,
  listChats,
  chat,
  formatMessages,
  formatChats,
  type TelegramAction,
} from "./telegram.ts";
import { cwdOf, truncateForAgent } from "../../shared/index.ts";
import { renderToolCall } from "../../shared/tool-render.ts";

const ACTIONS = ["send", "read", "list", "chat"] as const;

const parameters = Type.Object({
  action: StringEnum(ACTIONS, {
    description: "The Telegram action to perform.",
  }),
  chat_id: Type.Optional(
    Type.String({
      description:
        "Telegram chat ID (numeric string or @username) — required for send/read/chat.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description: "Text of the message to send — required for send/chat.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description:
        "Maximum messages to return (1-100, default 10) — for read/chat.",
    }),
  ),
});
type TelegramParams = Static<typeof parameters>;

export interface TelegramToolDeps {
  loadConfig: () => TelegramConfig;
}

/**
 * The interesting half of a Telegram call, as one line:
 * `send @user "hello"`, `read @user`, `list`.
 */
export function describeCall(params: TelegramParams): string {
  const detail =
    params.chat_id && params.text
      ? `${params.chat_id} "${params.text.slice(0, 40)}${params.text.length > 40 ? "…" : ""}"`
      : (params.chat_id ?? "");
  return detail ? `${params.action} ${detail}` : params.action;
}

export function buildTelegramTool(deps: TelegramToolDeps) {
  return {
    name: "telegram",
    label: "Telegram",
    description:
      "Send and receive Telegram messages via the Bot API. Use 'send' to post a message, 'read' to fetch recent messages from a chat, 'list' to see recent conversations, or 'chat' to send a message and read the reply in one call.",
    promptSnippet:
      "Send and receive Telegram messages: send to post, read to fetch, list to see conversations, chat for a quick round-trip.",
    parameters,
    async execute(
      _toolCallId: string,
      params: TelegramParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ action: TelegramAction; chat_id?: string }>> {
      ctx?.ui?.setStatus?.("telegram", `telegram: ${describeCall(params)}…`);

      try {
        const cfg = deps.loadConfig();
        const action = params.action;

        // 'list' doesn't need chat_id
        if (action === "list") {
          const chats = await listChats(cfg);
          const text = truncateForAgent(formatChats(chats), {
            label: "telegram list",
          });
          return {
            content: [{ type: "text", text }],
            details: { action, chat_id: undefined },
          };
        }

        // All other actions need chat_id
        const chatId = params.chat_id ?? cfg.defaultChat;
        if (!chatId) {
          throw new Error(
            "[pi-telegram] 'chat_id' is required for this action (or set a defaultChat via /pi-telegram)",
          );
        }

        if (action === "send") {
          if (!params.text) {
            throw new Error(
              '[pi-telegram] "text" is required for action "send"',
            );
          }
          const sent = await sendMessage(chatId, params.text, cfg);
          const text = truncateForAgent(
            `Sent to ${chatId}:\n${sent.message_id}`,
            {
              label: "telegram send",
            },
          );
          return {
            content: [{ type: "text", text }],
            details: { action, chat_id: chatId },
          };
        }

        if (action === "read") {
          const limit = params.limit ?? 10;
          const messages = await readMessages(chatId, limit, cfg);
          const text = truncateForAgent(
            messages.length > 0
              ? `Messages from ${chatId}:\n${formatMessages(messages)}`
              : `No recent messages from ${chatId}.`,
            { label: "telegram read" },
          );
          return {
            content: [{ type: "text", text }],
            details: { action, chat_id: chatId },
          };
        }

        if (action === "chat") {
          if (!params.text) {
            throw new Error(
              '[pi-telegram] "text" is required for action "chat"',
            );
          }
          const limit = params.limit ?? 10;
          const { sent, replies } = await chat(chatId, params.text, limit, cfg);
          const lines = [`Sent to ${chatId} (message ${sent.message_id})`];
          if (replies.length > 0) {
            lines.push("", "Replies:", formatMessages(replies));
          } else {
            lines.push("", "(no reply yet)");
          }
          const text = truncateForAgent(lines.join("\n"), {
            label: "telegram chat",
          });
          return {
            content: [{ type: "text", text }],
            details: { action, chat_id: chatId },
          };
        }

        throw new Error(`[pi-telegram] unknown action "${action}"`);
      } finally {
        ctx?.ui?.setStatus?.("telegram", undefined);
      }
    },
    renderCall(
      args: TelegramParams,
      theme: Theme,
      context?: { lastComponent?: unknown },
    ) {
      return renderToolCall(
        "telegram",
        describeCall(args),
        theme,
        context?.lastComponent,
      );
    },
  };
}
