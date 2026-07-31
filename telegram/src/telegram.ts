/**
 * The Bot API, as the four calls a bridge needs.
 *
 * What this replaced was a tool's view of Telegram: `read`, `list`, and a `chat` round-trip,
 * all of them polling `getUpdates` with a **negative** offset because nothing tracked where it
 * had got to. A negative offset means "the last N updates, and forget everything before them",
 * which is a reasonable way to answer "what was said recently?" and the wrong primitive for a
 * listener — it confirms nothing, so the same message comes back on the next poll, and it
 * discards any backlog deeper than one page.
 *
 * A bridge needs the other half of the same API: a **confirming** offset. Passing
 * `last_update_id + 1` tells Telegram those updates were handled, so each message is delivered
 * once and only once. That is the whole difference between reading a chat and listening to it.
 */
import type { TelegramConfig } from "./config.ts";

/** A Telegram message as returned by the Bot API. */
export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; username?: string };
  text?: string;
  date: number;
}

/** One `getUpdates` element, in the two shapes this extension asks for. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/**
 * The one HTTP call this extension makes, injected rather than reached for directly.
 *
 * The same seam `shared/exec.ts` gives every extension that shells out, for the same
 * reason: a module that closes over the global `fetch` can only be tested against the
 * network. Structural rather than `typeof fetch` so a stub is an object literal instead of a
 * `Response`.
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
   * Carries both reasons to stop: the session ended, or the call outlived its deadline.
   * See `shared/deadline.ts`, which exists because pi-lens once accepted a signal and
   * honored neither.
   */
  signal?: AbortSignal;
}

const API_ROOT = "https://api.telegram.org";

/** The Bot API's own ceiling for one `getUpdates` page. */
export const MAX_UPDATES = 100;

/**
 * How long one `getUpdates` may hold the connection open.
 *
 * Long polling, not a poll loop: Telegram holds the request until something arrives or this
 * elapses, so an idle bridge makes one request every 25 seconds instead of one every second,
 * and a message that does arrive is delivered in the time it takes the HTTP response to come
 * back rather than on the next tick. The number is under Telegram's 50s cap with room for the
 * request itself to be slow.
 */
export const POLL_TIMEOUT_SEC = 25;

/**
 * JSON, not a bare word.
 *
 * The Bot API parses `allowed_updates` as a JSON array and rejects
 * `allowed_updates=message` with "can't parse allowed_updates JSON object" — so every read
 * failed against a real bot. `edited_message` is listed because {@link textOf} accepts an
 * edit in place of a message; asking for one and reading the other is how that branch would
 * have stayed permanently dead.
 */
const ALLOWED_UPDATES = JSON.stringify(["message", "edited_message"]);

/**
 * Never let the bot token reach a message.
 *
 * It is a credential, it sits in the URL path because that is where the Bot API puts
 * it, and these messages are shown to the user and written to logs.
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

/** Was this rejection us stopping, rather than Telegram failing? */
export function wasAborted(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError";
}

/** Call one Bot API method over HTTPS. */
async function callTelegramApi(
  method: string,
  params: Record<string, string | number | undefined>,
  deps: TelegramDeps,
): Promise<unknown> {
  const { token } = deps.config;
  if (!token) {
    throw new Error("[pi-telegram] no bot token configured — set one via /pi-telegram");
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
    // Rethrown as-is when it is our own abort, so a caller can tell "we stopped" from
    // "Telegram is down" without parsing prose — the poll loop's exit depends on it.
    if (wasAborted(err)) throw err;
    throw new Error(`[pi-telegram] ${method} failed: ${redact(reason(err), token)}`);
  }

  let body: { ok?: boolean; result?: unknown; description?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Telegram answers some failures with HTML, and a proxy in front of it can answer with
    // anything at all. Reporting that as "unknown error" hid the status code, which is the
    // only part of it worth having.
    throw new Error(
      `[pi-telegram] ${method} returned a non-JSON response (HTTP ${response.status})`,
    );
  }

  if (!body.ok) {
    const detail = body.description ?? `HTTP ${response.status}`;
    throw new Error(`[pi-telegram] API error (${method}): ${redact(detail, token)}`);
  }

  return body.result;
}

/** Send a text message to a chat. Returns the sent message. */
export async function sendMessage(
  chatId: string,
  text: string,
  deps: TelegramDeps,
): Promise<TelegramMessage> {
  const result = await callTelegramApi("sendMessage", { chat_id: chatId, text }, deps);
  return result as TelegramMessage;
}

/** The message an update carries, edits included, or `null`. */
export const messageOf = (update: TelegramUpdate): TelegramMessage | null =>
  update.message ?? update.edited_message ?? null;

export interface Poll {
  updates: TelegramUpdate[];
  /**
   * The offset to pass next time — `max(update_id) + 1`, or the one given when nothing
   * arrived.
   *
   * Returned rather than tracked in here because it is the caller's durable state: the loop
   * that owns it is the loop that must not lose it, and a module-level cursor would be shared
   * by every session in the process.
   */
  nextOffset: number;
}

/**
 * One long poll. Returns as soon as anything arrives, or empty after {@link POLL_TIMEOUT_SEC}.
 *
 * `offset` must be a **confirming** offset: everything below it is acknowledged and will never
 * be sent again. That is what makes each message arrive exactly once, and it is why the
 * caller has to thread `nextOffset` through — see {@link startingOffset} for where the first
 * one comes from.
 */
export async function poll(
  offset: number,
  deps: TelegramDeps,
  timeoutSec: number = POLL_TIMEOUT_SEC,
): Promise<Poll> {
  const result = await callTelegramApi(
    "getUpdates",
    { offset, timeout: timeoutSec, limit: MAX_UPDATES, allowed_updates: ALLOWED_UPDATES },
    deps,
  );
  const updates = (result ?? []) as TelegramUpdate[];
  const highest = updates.reduce((max, u) => (u.update_id > max ? u.update_id : max), -1);
  return { updates, nextOffset: highest >= 0 ? highest + 1 : offset };
}

/**
 * Where to start listening: **after** whatever is already queued.
 *
 * A bot's update queue holds up to 24 hours of unretrieved messages, so a bridge that started
 * from offset 0 would open by replaying every message sent since the bot was last online —
 * into a coding agent, as instructions, at once. Asking for the last update with `offset: -1`
 * and starting one past it makes "start listening" mean *now*.
 *
 * The cost is stated in Telegram's own docs for the negative form: the backlog is forgotten.
 * That is the intent here rather than a side effect — an hours-old "run the tests" is not a
 * request anyone still wants honoured.
 */
export async function startingOffset(deps: TelegramDeps): Promise<number> {
  const result = await callTelegramApi(
    "getUpdates",
    { offset: -1, timeout: 0, limit: 1, allowed_updates: ALLOWED_UPDATES },
    deps,
  );
  const updates = (result ?? []) as TelegramUpdate[];
  const last = updates.at(-1);
  return last ? last.update_id + 1 : 0;
}

/**
 * Does this message belong to the chat named by config?
 *
 * `chat` is documented as "numeric string or @username" — by the config field, by the README,
 * and by the Bot API itself, which accepts either for `sendMessage`. Comparing only against
 * `chat.id` meant a chat named by `@username` matched nothing, and here that is not a missing
 * read but a **closed door**: the owner's own messages would be treated as a stranger's.
 *
 * Usernames are case-insensitive on Telegram's side, so the comparison is too.
 */
export function matchesChat(msg: TelegramMessage, chatId: string): boolean {
  if (String(msg.chat.id) === chatId) return true;
  if (!chatId.startsWith("@")) return false;
  const wanted = chatId.slice(1).toLowerCase();
  return wanted.length > 0 && msg.chat.username?.toLowerCase() === wanted;
}

/** How a chat is named to the user, for the "who just wrote to your bot?" notice. */
export function describeSender(msg: TelegramMessage): string {
  const who = msg.from?.username
    ? `@${msg.from.username}`
    : (msg.from?.first_name ?? msg.chat.title ?? "unknown");
  return `${who} (chat ${msg.chat.id})`;
}
