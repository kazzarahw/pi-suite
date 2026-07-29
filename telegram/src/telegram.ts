import type { TelegramConfig } from "./config.ts";

/** A Telegram message as returned by the Bot API. */
export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; username?: string };
  text?: string;
  date: number;
}

/** A chat the bot has interacted with. */
export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_message?: string;
  last_date?: number;
}

export type TelegramAction = "send" | "read" | "list" | "chat";

export interface TelegramArgs {
  chat_id?: string;
  text?: string;
  limit?: number;
}

/**
 * Call the Telegram Bot API over HTTPS.
 *
 * Uses Node's built-in https module (no extra dependencies). The token is passed
 * as part of the URL path, following the Bot API pattern.
 */
async function callTelegramApi(
  method: string,
  params: Record<string, string | number | undefined>,
  token: string,
): Promise<unknown> {
  if (!token) {
    throw new Error(
      "[pi-telegram] no bot token configured — set one via /pi-telegram token <token>",
    );
  }

  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString());
  const body = (await response.json()) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };

  if (!body.ok) {
    throw new Error(
      `[pi-telegram] API error (${method}): ${body.description ?? "unknown error"}`,
    );
  }

  return body.result;
}

/**
 * Send a text message to a chat.
 * Returns the sent message object.
 */
export async function sendMessage(
  chatId: string,
  text: string,
  config: TelegramConfig,
): Promise<TelegramMessage> {
  const result = await callTelegramApi(
    "sendMessage",
    { chat_id: chatId, text },
    config.token,
  );
  return result as TelegramMessage;
}

/**
 * Fetch recent messages from a chat.
 *
 * Uses getUpdates to fetch the most recent `limit` messages for a given chat.
 * If the chat has no recent updates, returns an empty list.
 */
export async function readMessages(
  chatId: string,
  limit: number,
  config: TelegramConfig,
): Promise<TelegramMessage[]> {
  // GetUpdates returns updates across all chats; we filter for our chat.
  const result = await callTelegramApi(
    "getUpdates",
    { timeout: 0, limit: Math.min(limit, 100), allowed_updates: "message" },
    config.token,
  );

  const updates = result as Array<{
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
  }>;

  const messages: TelegramMessage[] = [];
  for (const update of updates) {
    const msg = update.message ?? update.edited_message;
    if (msg && String(msg.chat.id) === chatId) {
      messages.push(msg);
    }
  }

  // Return the most recent `limit` messages, newest last.
  return messages.slice(-limit);
}

/**
 * List recent chats the bot has seen messages from.
 *
 * Scans getUpdates for unique chats and returns them with the most recent
 * message preview.
 */
export async function listChats(
  config: TelegramConfig,
): Promise<TelegramChat[]> {
  const result = await callTelegramApi(
    "getUpdates",
    { timeout: 0, limit: 100, allowed_updates: "message" },
    config.token,
  );

  const updates = result as Array<{
    message?: TelegramMessage;
  }>;

  const seen = new Map<number, TelegramChat>();
  for (const update of updates) {
    const msg = update.message;
    if (!msg) continue;
    const id = msg.chat.id;
    if (!seen.has(id)) {
      const chat: TelegramChat = {
        id,
        type: msg.chat.type,
        title: msg.chat.title,
        username: msg.chat.username,
        first_name: msg.from?.first_name,
        last_message: msg.text,
        last_date: msg.date,
      };
      seen.set(id, chat);
    } else {
      // Update with most recent message
      const existing = seen.get(id)!;
      if (!existing.last_date || msg.date > existing.last_date) {
        existing.last_message = msg.text;
        existing.last_date = msg.date;
      }
    }
  }

  return [...seen.values()].sort(
    (a, b) => (b.last_date ?? 0) - (a.last_date ?? 0),
  );
}

/**
 * Send a message and read the reply in one call.
 *
 * Sends the message, then polls once for a response. Returns both the sent message
 * and any new messages that arrived after it.
 */
export async function chat(
  chatId: string,
  text: string,
  limit: number,
  config: TelegramConfig,
): Promise<{ sent: TelegramMessage; replies: TelegramMessage[] }> {
  const sent = await sendMessage(chatId, text, config);

  // Small delay to let the reply arrive, then fetch updates
  await new Promise((r) => setTimeout(r, 1500));
  const replies = await readMessages(chatId, limit, config);

  return { sent, replies };
}

/**
 * Format a TelegramMessage into a readable line.
 */
export function formatMessage(msg: TelegramMessage): string {
  const from = msg.from
    ? msg.from.username
      ? `@${msg.from.username}`
      : (msg.from.first_name ?? "unknown")
    : "system";
  const date = new Date(msg.date * 1000).toISOString();
  const text = msg.text ?? "(no text)";
  return `[${date}] ${from}: ${text}`;
}

/**
 * Format a list of TelegramMessages into a readable block.
 */
export function formatMessages(messages: TelegramMessage[]): string {
  if (messages.length === 0) return "(no messages)";
  return messages.map(formatMessage).join("\n");
}

/**
 * Format a TelegramChat into a readable line.
 */
export function formatChat(chat: TelegramChat): string {
  const name =
    chat.title ?? chat.username ?? chat.first_name ?? String(chat.id);
  const type = chat.type === "private" ? "DM" : chat.type;
  const preview = chat.last_message
    ? ` — "${chat.last_message.slice(0, 60)}"`
    : "";
  return `${name} (${type}, id: ${chat.id})${preview}`;
}

/**
 * Format a list of TelegramChats into a readable block.
 */
export function formatChats(chats: TelegramChat[]): string {
  if (chats.length === 0) return "(no recent chats)";
  return chats.map((c, i) => `${i + 1}. ${formatChat(c)}`).join("\n");
}
