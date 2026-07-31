import { test, expect } from "bun:test";
import {
  describeSender,
  matchesChat,
  messageOf,
  poll,
  sendMessage,
  startingOffset,
  wasAborted,
  type FetchFn,
  type TelegramDeps,
  type TelegramMessage,
} from "../src/telegram.ts";
import { DEFAULTS, type TelegramConfig } from "../src/config.ts";

const CONFIG: TelegramConfig = { ...DEFAULTS, token: "T", chat: "42" };

/** A fetch that answers every call with `{ ok: true, result }`, recording the URLs it saw. */
function stub(result: unknown, body?: unknown, status = 200) {
  const urls: string[] = [];
  const fetch: FetchFn = (url) => {
    urls.push(url);
    return Promise.resolve({
      ok: status < 400,
      status,
      json: async () => body ?? { ok: true, result },
    });
  };
  return { fetch, urls, params: () => new URL(urls.at(-1)!).searchParams };
}

const deps = (fetch: FetchFn, config: TelegramConfig = CONFIG): TelegramDeps => ({ config, fetch });

const message = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
  message_id: 1,
  chat: { id: 42, type: "private" },
  date: 1_700_000_000,
  text: "hello",
  ...over,
});

// ---------------------------------------------------------------------------
// The offset contract — the difference between reading a chat and listening to one.
// ---------------------------------------------------------------------------

/**
 * The defect this module was rebuilt around.
 *
 * The tool version polled with a *negative* offset, which confirms nothing: the same updates come
 * back on every call. A bridge built on that would deliver every message forever.
 */
test("poll returns a confirming offset, one past the highest update seen", async () => {
  const s = stub([
    { update_id: 10, message: message() },
    { update_id: 12, message: message({ message_id: 2 }) },
  ]);
  const result = await poll(0, deps(s.fetch), 0);
  expect(result.updates).toHaveLength(2);
  expect(result.nextOffset).toBe(13);
});

test("poll keeps the offset it was given when nothing arrived", async () => {
  expect((await poll(99, deps(stub([]).fetch), 0)).nextOffset).toBe(99);
});

test("poll asks for a long poll, and for both message shapes", async () => {
  const s = stub([]);
  await poll(7, deps(s.fetch), 25);
  expect(s.params().get("offset")).toBe("7");
  expect(s.params().get("timeout")).toBe("25");
  // JSON, not a bare word: the Bot API rejects `allowed_updates=message` outright, which is
  // what made every read fail against a real bot.
  expect(s.params().get("allowed_updates")).toBe('["message","edited_message"]');
});

/**
 * Starting *after* the queue, not at the front of it.
 *
 * A bot's update queue holds 24 hours of unretrieved messages, so starting from 0 would open the
 * session by replaying all of them into the agent, as instructions, at once.
 */
test("startingOffset skips whatever is already queued", async () => {
  const s = stub([{ update_id: 500, message: message() }]);
  expect(await startingOffset(deps(s.fetch))).toBe(501);
  expect(s.params().get("offset")).toBe("-1");
  expect(s.params().get("limit")).toBe("1");
});

test("startingOffset is 0 for a bot nobody has written to", async () => {
  expect(await startingOffset(deps(stub([]).fetch))).toBe(0);
});

test("messageOf accepts an edit in place of a message", () => {
  expect(messageOf({ update_id: 1, message: message({ text: "a" }) })?.text).toBe("a");
  expect(messageOf({ update_id: 1, edited_message: message({ text: "b" }) })?.text).toBe("b");
  expect(messageOf({ update_id: 1 })).toBeNull();
});

// ---------------------------------------------------------------------------
// Authorisation. Here a missed match is a closed door, not a missing read.
// ---------------------------------------------------------------------------

test("a chat matches by numeric id or by @username, case-insensitively", () => {
  expect(matchesChat(message(), "42")).toBe(true);
  expect(matchesChat(message(), "43")).toBe(false);
  const named = message({ chat: { id: 7, type: "channel", username: "MyChannel" } });
  expect(matchesChat(named, "@mychannel")).toBe(true);
  expect(matchesChat(named, "@MYCHANNEL")).toBe(true);
  // The id still wins where it is the thing configured.
  expect(matchesChat(named, "7")).toBe(true);
  expect(matchesChat(named, "@other")).toBe(false);
});

test("a bare @ matches nothing rather than everything", () => {
  expect(matchesChat(message({ chat: { id: 7, type: "channel", username: "x" } }), "@")).toBe(false);
});

test("describeSender names whoever wrote, so the user can authorise them", () => {
  expect(describeSender(message({ from: { id: 1, username: "kazzarah" } }))).toBe(
    "@kazzarah (chat 42)",
  );
  expect(describeSender(message({ from: { id: 1, first_name: "K" } }))).toBe("K (chat 42)");
  expect(describeSender(message())).toBe("unknown (chat 42)");
});

// ---------------------------------------------------------------------------
// Failure reporting, and the credential.
// ---------------------------------------------------------------------------

test("no token is refused before any request is made", async () => {
  const s = stub([]);
  await expect(poll(0, deps(s.fetch, { ...CONFIG, token: "" }), 0)).rejects.toThrow(/no bot token/);
  expect(s.urls).toEqual([]);
});

test("an API-level failure reports Telegram's own description", async () => {
  const s = stub(null, { ok: false, description: "Unauthorized" });
  await expect(poll(0, deps(s.fetch), 0)).rejects.toThrow(/Unauthorized/);
});

test("a non-JSON response keeps the status code, which is the only useful part", async () => {
  const fetch: FetchFn = () =>
    Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error("not json")) });
  await expect(poll(0, deps(fetch), 0)).rejects.toThrow(/HTTP 502/);
});

/**
 * The token never reaches a message.
 *
 * It sits in the URL path because that is where the Bot API puts it, and these strings are shown
 * to the user and written to logs.
 */
test("the token is redacted out of both failure paths", async () => {
  const secret = "8113038589:AAH-secret";
  const cfg = { ...CONFIG, token: secret };

  const apiError = stub(null, { ok: false, description: `bad token ${secret}` });
  await expect(poll(0, deps(apiError.fetch, cfg), 0)).rejects.toThrow(/<token>/);

  const netError: FetchFn = () => Promise.reject(new Error(`connect failed to ${secret}`));
  const thrown = await poll(0, deps(netError, cfg), 0).catch((e: Error) => e.message);
  expect(thrown).toContain("<token>");
  expect(thrown).not.toContain(secret);
});

/**
 * An abort is rethrown as itself rather than wrapped in prose.
 *
 * The poll loop's exit depends on telling "we stopped" from "Telegram is down": one ends the
 * loop, the other backs off and retries.
 */
test("an abort is distinguishable from a network failure", async () => {
  const abort: FetchFn = () =>
    Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  const err = await poll(0, deps(abort), 0).catch((e: unknown) => e);
  expect(wasAborted(err)).toBe(true);
  expect(wasAborted(new Error("connection reset"))).toBe(false);
});

test("sendMessage posts the text to the named chat", async () => {
  const s = stub({ message_id: 9, chat: { id: 42, type: "private" }, date: 1 });
  const sent = await sendMessage("42", "done", deps(s.fetch));
  expect(sent.message_id).toBe(9);
  expect(s.params().get("chat_id")).toBe("42");
  expect(s.params().get("text")).toBe("done");
});
