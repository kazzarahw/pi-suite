import { test, expect } from "bun:test";
import {
  sendMessage,
  readMessages,
  listChats,
  chat,
  type FetchFn,
  type TelegramDeps,
  type TelegramMessage,
} from "../src/telegram.ts";

/**
 * The half of pi-telegram that talks to Telegram.
 *
 * It had no tests at all — it closed over the global `fetch`, so the only way to run it
 * was against the network. The `FetchFn` seam is what makes these possible, and two of
 * the bugs below (a bare-word `allowed_updates`, a page size taken from the caller's
 * `limit`) were live defects that no amount of testing the formatters could have found.
 */

const TOKEN = "123456:AAH-secret-token";
const CONFIG = { token: TOKEN, defaultChat: "" };

/** A fetch that records its URLs and replays one canned `ok` body per call. */
function okFetch(...results: unknown[]): { fn: FetchFn; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fn: FetchFn = async (url) => {
    urls.push(url);
    const result = results[Math.min(i++, results.length - 1)];
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  return { fn, urls };
}

const deps = (fn: FetchFn, extra?: Partial<TelegramDeps>): TelegramDeps => ({
  config: CONFIG,
  fetch: fn,
  replyWaitMs: 0,
  ...extra,
});

const msg = (over: Partial<TelegramMessage> & { chat: TelegramMessage["chat"] }): TelegramMessage => ({
  message_id: 1,
  date: 1700000000,
  text: "hi",
  ...over,
});

const update = (m: TelegramMessage) => ({ message: m });

// ---------------------------------------------------------------------------
// The call itself
// ---------------------------------------------------------------------------

test("sendMessage passes chat_id and text, and returns the sent message", async () => {
  const { fn, urls } = okFetch({ message_id: 42, chat: { id: 7, type: "private" }, date: 1 });
  const sent = await sendMessage("@alice", "hello", deps(fn));

  expect(sent.message_id).toBe(42);
  const url = new URL(urls[0]!);
  expect(url.pathname).toBe(`/bot${TOKEN}/sendMessage`);
  expect(url.searchParams.get("chat_id")).toBe("@alice");
  expect(url.searchParams.get("text")).toBe("hello");
});

test("a missing token fails before any request is made", async () => {
  let called = false;
  const fn: FetchFn = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await expect(
    sendMessage("1", "x", { config: { token: "", defaultChat: "" }, fetch: fn }),
  ).rejects.toThrow(/no bot token configured/);
  expect(called).toBe(false);
});

test("an API-level failure surfaces Telegram's own description", async () => {
  const fn: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
  });
  await expect(sendMessage("1", "x", deps(fn))).rejects.toThrow(/chat not found/);
});

test("a non-JSON response reports the status instead of 'unknown error'", async () => {
  const fn: FetchFn = async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  });
  await expect(sendMessage("1", "x", deps(fn))).rejects.toThrow(/non-JSON response \(HTTP 502\)/);
});

test("a network failure is reported as a failure of the method", async () => {
  const fn: FetchFn = async () => {
    throw new TypeError("fetch failed");
  };
  await expect(sendMessage("1", "x", deps(fn))).rejects.toThrow(
    /\[pi-telegram\] sendMessage failed: fetch failed/,
  );
});

test("the deadline and the user's cancel are told apart", async () => {
  const abort = (name: string): FetchFn => async () => {
    const err = new Error("aborted");
    err.name = name;
    throw err;
  };
  await expect(sendMessage("1", "x", deps(abort("TimeoutError")))).rejects.toThrow(/timed out/);
  await expect(sendMessage("1", "x", deps(abort("AbortError")))).rejects.toThrow(/cancelled/);
});

/**
 * The token is a credential, it lives in the URL path because that is where the Bot API
 * puts it, and these messages go to the agent and into logs. A platform that echoes the
 * request URL back in its error — several do — would otherwise leak it verbatim.
 */
test("the bot token never reaches an error message", async () => {
  const fn: FetchFn = async (url) => {
    throw new TypeError(`request to ${url} failed`);
  };
  const err: Error = await sendMessage("1", "x", deps(fn)).then(
    () => new Error("expected the request to fail"),
    (e: Error) => e,
  );
  expect(err.message).not.toContain(TOKEN);
  expect(err.message).toContain("<token>");
});

test("the signal reaches the request", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const fn: FetchFn = async (_url, init) => {
    seen.push(init?.signal);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const signal = AbortSignal.timeout(60_000);
  await sendMessage("1", "x", deps(fn, { signal }));
  expect(seen[0]).toBe(signal);
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/**
 * The regression that made `read` useless on any bot with more than one conversation.
 *
 * `getUpdates` pages over *every* chat. Asking it for the caller's `limit` and then
 * keeping the ones for this chat returns nothing whenever the newest few updates belong
 * to someone else — so a chat with messages sitting in it reported "no recent messages".
 */
test("read asks for a full page regardless of the caller's limit, then trims", async () => {
  const mine = { id: 5, type: "private" as const };
  const theirs = { id: 9, type: "private" as const };
  const { fn, urls } = okFetch([
    update(msg({ chat: theirs, text: "noise", date: 10 })),
    update(msg({ chat: theirs, text: "noise", date: 11 })),
    update(msg({ chat: mine, text: "first", date: 12 })),
    update(msg({ chat: mine, text: "second", date: 13 })),
  ]);

  const got = await readMessages("5", 1, deps(fn));

  expect(new URL(urls[0]!).searchParams.get("limit")).toBe("100");
  expect(got.map((m) => m.text)).toEqual(["second"]);
});

test("allowed_updates is sent as JSON, which is the only form the Bot API accepts", async () => {
  const { fn, urls } = okFetch([]);
  await readMessages("5", 10, deps(fn));
  const allowed = new URL(urls[0]!).searchParams.get("allowed_updates");
  expect(JSON.parse(allowed!)).toEqual(["message", "edited_message"]);
});

test("read accepts an edited message in place of a message", async () => {
  const { fn } = okFetch([
    { edited_message: msg({ chat: { id: 5, type: "private" }, text: "fixed" }) },
  ]);
  expect((await readMessages("5", 10, deps(fn))).map((m) => m.text)).toEqual(["fixed"]);
});

test("read returns nothing when the chat has no updates", async () => {
  const { fn } = okFetch([]);
  expect(await readMessages("5", 10, deps(fn))).toEqual([]);
});

test("read tolerates a result the API omitted entirely", async () => {
  const fn: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  });
  expect(await readMessages("5", 10, deps(fn))).toEqual([]);
});

test("a non-positive limit returns nothing rather than the whole page", async () => {
  const { fn } = okFetch([update(msg({ chat: { id: 5, type: "private" } }))]);
  expect(await readMessages("5", 0, deps(fn))).toEqual([]);
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list collapses updates to one entry per chat, newest first, with the newest preview", async () => {
  const a = { id: 1, type: "private" as const };
  const b = { id: 2, type: "group" as const, title: "Group" };
  const { fn } = okFetch([
    update(msg({ chat: a, text: "old", date: 100, from: { id: 9, first_name: "Alice" } })),
    update(msg({ chat: b, text: "newest", date: 300 })),
    update(msg({ chat: a, text: "newer", date: 200 })),
  ]);

  const chats = await listChats(deps(fn));

  expect(chats.map((c) => c.id)).toEqual([2, 1]);
  expect(chats.find((c) => c.id === 1)?.last_message).toBe("newer");
  expect(chats.find((c) => c.id === 1)?.first_name).toBe("Alice");
});

test("list returns nothing when the bot has seen no chats", async () => {
  const { fn } = okFetch([]);
  expect(await listChats(deps(fn))).toEqual([]);
});

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

test("chat sends, then reads that chat's replies", async () => {
  const { fn, urls } = okFetch(
    { message_id: 7, chat: { id: 5, type: "private" }, date: 1 },
    [update(msg({ message_id: 8, chat: { id: 5, type: "private" }, text: "sure" }))],
  );

  const { sent, replies } = await chat("5", "ping", 10, deps(fn));

  expect(sent.message_id).toBe(7);
  expect(replies.map((m) => m.text)).toEqual(["sure"]);
  expect(new URL(urls[0]!).pathname).toEndWith("/sendMessage");
  expect(new URL(urls[1]!).pathname).toEndWith("/getUpdates");
});

test("chat does not present the chat's existing messages as replies to the send", async () => {
  // The failure this pins was total rather than cosmetic: `readMessages` returns a chat's
  // recent traffic whatever its age, so labelling it "Replies:" reported whatever was
  // already sitting there — very often the message the agent was answering — as a fresh
  // response. A quiet chat produced a confident, entirely fabricated round-trip.
  const { fn } = okFetch({ message_id: 7, chat: { id: 5, type: "private" }, date: 1 }, [
    update(msg({ message_id: 5, chat: { id: 5, type: "private" }, text: "older" })),
    update(msg({ message_id: 6, chat: { id: 5, type: "private" }, text: "also older" })),
    update(msg({ message_id: 9, chat: { id: 5, type: "private" }, text: "actual reply" })),
  ]);

  const { replies } = await chat("5", "ping", 10, deps(fn));

  expect(replies.map((m) => m.text)).toEqual(["actual reply"]);
});

test("read and list ask for the newest page, not the oldest unconfirmed one", async () => {
  // `getUpdates` with no offset serves the *oldest* unconfirmed updates, and nothing here
  // ever confirms one — so past a hundred of them inside Telegram's 24h window, every
  // read returned the same stale page and new messages were permanently invisible. A
  // negative offset reads from the end of the queue and still confirms nothing.
  const { fn, urls } = okFetch([]);
  await readMessages("5", 10, deps(fn));
  expect(new URL(urls[0]!).searchParams.get("offset")).toBe("-100");

  const { fn: fn2, urls: urls2 } = okFetch([]);
  await listChats(deps(fn2));
  expect(new URL(urls2[0]!).searchParams.get("offset")).toBe("-100");
});

test("chat reports no reply rather than inventing one", async () => {
  const { fn } = okFetch({ message_id: 7, chat: { id: 5, type: "private" }, date: 1 }, []);
  expect((await chat("5", "ping", 10, deps(fn))).replies).toEqual([]);
});

test("an already-cancelled call does not sit through the reply wait", async () => {
  const { fn } = okFetch({ message_id: 7, chat: { id: 5, type: "private" }, date: 1 }, []);
  const controller = new AbortController();
  controller.abort();
  // The real wait, but a signal that is already down: `sleep` returns immediately rather
  // than holding the tool open for a reply that cancellation means nobody wants.
  const started = performance.now();
  await chat("5", "ping", 10, deps(fn, { replyWaitMs: 5_000, signal: controller.signal }));
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("the reply wait elapses when nothing cancels it", async () => {
  const { fn } = okFetch({ message_id: 7, chat: { id: 5, type: "private" }, date: 1 }, []);
  const started = performance.now();
  await chat("5", "ping", 10, deps(fn, { replyWaitMs: 25 }));
  expect(performance.now() - started).toBeGreaterThanOrEqual(20);
});

test("read matches a chat named by @username, not only by numeric id", async () => {
  // `chat_id` is documented as "numeric string or @username" — by the tool schema, by
  // `defaultChat`, and by `sendMessage`, which passes either straight through. The reader
  // compared only against `chat.id`, so every `read` and every `chat` naming a channel or
  // a public group by @username filtered out its own messages and reported "no recent
  // messages" with them sitting right there.
  const { fn } = okFetch([
    update(msg({ chat: { id: 5, type: "channel", username: "MyChannel" }, text: "in scope" })),
    update(msg({ message_id: 2, chat: { id: 9, type: "private" }, text: "someone else" })),
  ]);

  const got = await readMessages("@mychannel", 10, deps(fn));
  expect(got.map((m) => m.text)).toEqual(["in scope"]);
});

test("an @username naming no chat in the page still returns nothing", async () => {
  // The other direction of the same comparison: matching must stay a match, not become a
  // fallback that hands back somebody else's traffic.
  const { fn } = okFetch([
    update(msg({ chat: { id: 5, type: "channel", username: "MyChannel" } })),
  ]);
  expect(await readMessages("@other", 10, deps(fn))).toEqual([]);
});
