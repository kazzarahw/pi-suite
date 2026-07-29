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
 * The one HTTP call this extension makes, injected rather than reached for directly.
 *
 * The same seam `shared/exec.ts` gives every extension that shells out, for the same
 * reason: a module that closes over the global `fetch` can only be tested against the
 * network, so the half of this file that talks to Telegram had no tests at all and the
 * per-file coverage floor in `bunfig.toml` caught it. Structural rather than `typeof
 * fetch` so a stub is an object literal instead of a `Response`.
 */
export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The real one. Global `fetch`, so there is no dependency to install. */
export const defaultFetch: FetchFn = (url, init) => fetch(url, init);

export interface TelegramDeps {
  config: TelegramConfig;
  fetch: FetchFn;
  /**
   * Carries both reasons to stop: the user cancelled, or the call outlived its
   * deadline. Built by `deadline()` at the tool boundary — see `shared/deadline.ts`,
   * which exists because pi-lens once accepted a signal and honored neither.
   */
  signal?: AbortSignal;
  /** Overridable only so tests do not sit through the real wait. */
  replyWaitMs?: number;
}

const API_ROOT = "https://api.telegram.org";

/** The Bot API's own ceiling for one `getUpdates` page. */
const MAX_UPDATES = 100;

/** How long `chat` gives a reply to arrive before reading. */
export const REPLY_WAIT_MS = 1500;

/**
 * JSON, not a bare word.
 *
 * The Bot API parses `allowed_updates` as a JSON array and rejects
 * `allowed_updates=message` with "can't parse allowed_updates JSON object" — so every
 * read and list failed against a real bot. `edited_message` is listed because the
 * reader below accepts an edit in place of a message; asking for one and reading the
 * other is how that branch would have stayed permanently dead.
 */
const ALLOWED_UPDATES = JSON.stringify(["message", "edited_message"]);

/**
 * Never let the bot token reach a message.
 *
 * It is a credential, it sits in the URL path because that is where the Bot API puts
 * it, and these messages are handed to the agent and written to logs.
 */
function redact(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

/** Why a fetch rejected, in the caller's terms rather than the platform's. */
function reason(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError") return "timed out";
  if (name === "AbortError") return "cancelled";
  return err instanceof Error && err.message ? err.message : "network error";
}

/** Call one Bot API method over HTTPS. */
async function callTelegramApi(
  method: string,
  params: Record<string, string | number | undefined>,
  deps: TelegramDeps,
): Promise<unknown> {
  const { token } = deps.config;
  if (!token) {
    throw new Error(
      "[pi-telegram] no bot token configured — set one via /pi-telegram",
    );
  }

  const url = new URL(`${API_ROOT}/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await deps.fetch(url.toString(), { signal: deps.signal });
  } catch (err) {
    throw new Error(
      `[pi-telegram] ${method} failed: ${redact(reason(err), token)}`,
    );
  }

  let body: { ok?: boolean; result?: unknown; description?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Telegram answers some failures with HTML, and a proxy in front of it can answer
    // with anything at all. Reporting that as "unknown error" hid the status code, which
    // is the only part of it worth having.
    throw new Error(
      `[pi-telegram] ${method} returned a non-JSON response (HTTP ${response.status})`,
    );
  }

  if (!body.ok) {
    const detail = body.description ?? `HTTP ${response.status}`;
    throw new Error(
      `[pi-telegram] API error (${method}): ${redact(detail, token)}`,
    );
  }

  return body.result;
}

/**
 * Wait `ms`, returning early if the signal aborts.
 *
 * Resolves rather than rejects on abort: the caller's next API call is already bound to
 * the same signal, so it reports the cancellation with the right wording and this stays
 * free of reason-plumbing.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Send a text message to a chat.
 * Returns the sent message object.
 */
export async function sendMessage(
  chatId: string,
  text: string,
  deps: TelegramDeps,
): Promise<TelegramMessage> {
  const result = await callTelegramApi(
    "sendMessage",
    { chat_id: chatId, text },
    deps,
  );
  return result as TelegramMessage;
}

/**
 * Fetch recent messages from a chat.
 *
 * `limit` bounds what this returns, never what `getUpdates` is asked for. Updates page
 * over every chat the bot can see, so requesting `limit` of them and *then* keeping the
 * ones for this chat comes back empty whenever the newest few belong to someone else —
 * `read` on a quiet chat reported "no recent messages" with the messages sitting right
 * there. Take the full page, filter, then trim.
 */
export async function readMessages(
  chatId: string,
  limit: number,
  deps: TelegramDeps,
): Promise<TelegramMessage[]> {
  const result = await callTelegramApi(
    "getUpdates",
    { timeout: 0, limit: MAX_UPDATES, allowed_updates: ALLOWED_UPDATES },
    deps,
  );

  const updates = (result ?? []) as Array<{
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
  }>;

  const messages: TelegramMessage[] = [];
  for (const update of updates) {
    const msg = update.message ?? update.edited_message;
    if (msg && String(msg.chat.id) === chatId) messages.push(msg);
  }

  // Newest last, so the most recent `limit` are the tail.
  return limit > 0 ? messages.slice(-limit) : [];
}

/**
 * List recent chats the bot has seen messages from.
 *
 * Scans getUpdates for unique chats and returns them with the most recent
 * message preview.
 */
export async function listChats(deps: TelegramDeps): Promise<TelegramChat[]> {
  const result = await callTelegramApi(
    "getUpdates",
    { timeout: 0, limit: MAX_UPDATES, allowed_updates: ALLOWED_UPDATES },
    deps,
  );

  const updates = (result ?? []) as Array<{
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
  }>;

  const seen = new Map<number, TelegramChat>();
  for (const update of updates) {
    const msg = update.message ?? update.edited_message;
    if (!msg) continue;
    const id = msg.chat.id;
    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, {
        id,
        type: msg.chat.type,
        title: msg.chat.title,
        username: msg.chat.username,
        first_name: msg.from?.first_name,
        last_message: msg.text,
        last_date: msg.date,
      });
    } else if (!existing.last_date || msg.date > existing.last_date) {
      existing.last_message = msg.text;
      existing.last_date = msg.date;
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
  deps: TelegramDeps,
): Promise<{ sent: TelegramMessage; replies: TelegramMessage[] }> {
  const sent = await sendMessage(chatId, text, deps);
  await sleep(deps.replyWaitMs ?? REPLY_WAIT_MS, deps.signal);
  const replies = await readMessages(chatId, limit, deps);
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
