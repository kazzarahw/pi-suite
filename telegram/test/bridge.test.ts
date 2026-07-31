import { test, expect } from "bun:test";
import { backoffFor, createBridge, fitMessage, MAX_MESSAGE_CHARS } from "../src/bridge.ts";
import { DEFAULTS, type TelegramConfig } from "../src/config.ts";
import type { FetchFn, TelegramMessage } from "../src/telegram.ts";
import { within } from "../../shared/test/harness.ts";

const message = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
  message_id: 1,
  chat: { id: 42, type: "private" },
  date: 1_700_000_000,
  text: "run the tests",
  ...over,
});

/**
 * A scriptable Bot API.
 *
 * `getUpdates` answers from `pages` in order and empties out afterwards, so the loop keeps
 * running without being fed the same message twice. `startingOffset` (recognisable by
 * `offset=-1`) always answers empty, so tests begin from 0 without a page of setup.
 */
function fakeApi(pages: TelegramMessage[][] = []) {
  const sent: string[] = [];
  const offsets: string[] = [];
  let cursor = 0;
  let failNext = 0;
  let id = 100;

  const fetch: FetchFn = (url) => {
    const u = new URL(url);
    const method = u.pathname.split("/").pop()!;
    if (method === "sendMessage") {
      sent.push(u.searchParams.get("text") ?? "");
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) });
    }
    const offset = u.searchParams.get("offset")!;
    if (offset === "-1") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) });
    }
    offsets.push(offset);
    if (failNext > 0) {
      failNext -= 1;
      return Promise.reject(new Error("network down"));
    }
    // Only advance past a page that actually exists. Incrementing on every poll would run the
    // cursor off the end during the idle polls a test spends waiting, so a page pushed later
    // would land behind it and never be read.
    const page = cursor < pages.length ? pages[cursor++]! : [];
    const result = page.map((m) => ({ update_id: id++, message: m }));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  };

  return {
    fetch,
    sent,
    offsets,
    /** Make the next `n` polls reject, as an unreachable network would. */
    breakFor(n: number): void {
      failNext = n;
    },
    /** Add another page for the loop to pick up on a later pass. */
    push(...msgs: TelegramMessage[]): void {
      pages.push(msgs);
    },
  };
}

interface Harness {
  delivered: string[];
  notices: Array<{ msg: string; level: string }>;
  api: ReturnType<typeof fakeApi>;
  bridge: ReturnType<typeof createBridge>;
}

function harness(cfg: Partial<TelegramConfig> = {}, pages: TelegramMessage[][] = []): Harness {
  const api = fakeApi(pages);
  const delivered: string[] = [];
  const notices: Array<{ msg: string; level: string }> = [];
  let config: TelegramConfig = { ...DEFAULTS, token: "T", chat: "42", ...cfg };
  const bridge = createBridge({
    loadConfig: () => config,
    fetch: api.fetch,
    deliver: (text) => delivered.push(text),
    notify: (msg, level) => notices.push({ msg, level }),
    // Everything that would make a test sit and wait, turned down to nothing — but never to a
    // resolved-promise fast path: `sleep` goes through `setTimeout` even at 0 so the loop still
    // yields to the timer queue, which is what lets `waitFor` below ever run.
    pollTimeoutSec: 0,
    backoffMs: () => 0,
    gapMs: 0,
  });
  return { delivered, notices, api, bridge, ...{ setConfig: (c: TelegramConfig) => (config = c) } };
}

/** Wait until `check` holds, or fail loudly rather than hanging the suite. */
async function waitFor(check: () => boolean, label: string, ms = 2000): Promise<void> {
  await within(
    ms,
    (async () => {
      while (!check()) await new Promise((r) => setTimeout(r, 1));
    })(),
  ).catch(() => {
    throw new Error(`timed out waiting for: ${label}`);
  });
}

// ---------------------------------------------------------------------------
// The inbound half — the thing the extension could not do at all before.
// ---------------------------------------------------------------------------

test("a message from the authorised chat is delivered to the agent", async () => {
  const h = harness({}, [[message({ text: "run the tests" })]]);
  h.bridge.start();
  await waitFor(() => h.delivered.length > 0, "a delivery");
  h.bridge.stop();
  expect(h.delivered).toEqual(["run the tests"]);
});

test("the loop advances its offset, so a message is delivered once", async () => {
  const h = harness({}, [[message({ text: "one" })], [], []]);
  h.bridge.start();
  await waitFor(() => h.api.offsets.length >= 3, "three polls");
  h.bridge.stop();
  expect(h.delivered).toEqual(["one"]);
  // First poll from 0, then from one past the update it saw, and it stays there.
  expect(h.api.offsets[0]).toBe("0");
  expect(h.api.offsets[1]).toBe("101");
  expect(h.api.offsets[2]).toBe("101");
});

test("an edited message counts, and blank text does not", async () => {
  const api = fakeApi();
  const delivered: string[] = [];
  const bridge = createBridge({
    loadConfig: () => ({ ...DEFAULTS, token: "T", chat: "42" }),
    fetch: api.fetch,
    deliver: (t) => delivered.push(t),
    notify: () => {},
    pollTimeoutSec: 0,
    backoffMs: () => 0,
    gapMs: 0,
  });
  api.push(message({ text: "   " }), message({ text: "  spaced  " }));
  bridge.start();
  await waitFor(() => delivered.length > 0, "a delivery");
  bridge.stop();
  // Trimmed, and the whitespace-only one never became a turn.
  expect(delivered).toEqual(["spaced"]);
});

// ---------------------------------------------------------------------------
// Authorisation. What an inbound message reaches is an agent with shell access.
// ---------------------------------------------------------------------------

test("a message from any other chat is refused, and reported once", async () => {
  const stranger = message({ chat: { id: 999, type: "private" }, from: { id: 999, username: "nope" } });
  const h = harness({}, [[stranger], [stranger], [stranger]]);
  h.bridge.start();
  await waitFor(() => h.notices.length > 0, "a notice");
  await waitFor(() => h.api.offsets.length >= 3, "three polls");
  h.bridge.stop();

  expect(h.delivered).toEqual([]);
  // Once per stranger, not once per message: a bot found by a spammer would otherwise bury the
  // terminal in this.
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]!.msg).toContain("@nope");
});

/**
 * With no chat authorised, the bridge reports who wrote and delivers nothing.
 *
 * This is deliberately not trust-on-first-use. Pairing with whoever messages first would hand
 * the session to whoever finds the bot first, and the bot's username is public. Reporting the id
 * solves the only real problem an unpaired user has — finding their own chat id — which is the
 * job the deleted `list` action was actually doing.
 */
test("with no authorised chat, nothing is delivered and the id is offered", async () => {
  const h = harness({ chat: "" }, [[message()]]);
  h.bridge.start();
  await waitFor(() => h.notices.length > 0, "a notice");
  h.bridge.stop();
  expect(h.delivered).toEqual([]);
  expect(h.notices[0]!.msg).toContain("/pi-telegram chat 42");
});

test("the bridge does not start without a token, or with listening turned off", () => {
  for (const cfg of [{ token: "" }, { bridge: false }]) {
    const h = harness(cfg);
    h.bridge.start();
    expect(h.bridge.listening()).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// Asking a question — one reader, so the answer cannot be raced away.
// ---------------------------------------------------------------------------

test("ask sends the question and resolves with the next owner message", async () => {
  const h = harness();
  h.bridge.start();
  const answer = h.bridge.ask("Approve bash?", 2000);
  await waitFor(() => h.api.sent.length > 0, "the question");
  h.api.push(message({ text: "yes" }));
  expect(await within(2000, answer)).toEqual({ asked: true, text: "yes" });
  h.bridge.stop();
  // The answer was consumed as an answer, not delivered as a new instruction.
  expect(h.delivered).toEqual([]);
});

test("ask times out as asked-but-silent, which is not the same as unreachable", async () => {
  const h = harness();
  h.bridge.start();
  expect(await within(2000, h.bridge.ask("Approve?", 30))).toEqual({ asked: true, text: null });
  h.bridge.stop();
});

/**
 * `asked: false` is the fail-open signal, and it has to be unmistakable.
 *
 * The approval gate lets a call through when nobody could be reached and refuses when a reachable
 * owner said nothing. One nullable string could not express the difference.
 */
test("ask reports asked:false when the question cannot be sent at all", async () => {
  const h = harness({ chat: "" });
  expect(await h.bridge.ask("Approve?", 30)).toEqual({ asked: false });
});

test("a second question is refused rather than stealing the first one's answer", async () => {
  const h = harness();
  h.bridge.start();
  const first = h.bridge.ask("First?", 2000);
  await waitFor(() => h.api.sent.length > 0, "the first question");
  expect(await h.bridge.ask("Second?", 2000)).toEqual({ asked: false });
  h.api.push(message({ text: "yes" }));
  expect(await within(2000, first)).toEqual({ asked: true, text: "yes" });
  h.bridge.stop();
});

/**
 * Cancelling the turn releases the question with it.
 *
 * `ctx.signal` is live while the agent streams, so Esc aborts it. Without honoring that, a user
 * who gave up on a tool call would still be held for the full approval deadline by it.
 */
test("aborting the turn releases the wait, and frees the slot for the next question", async () => {
  const h = harness();
  h.bridge.start();
  const turn = new AbortController();
  const answer = h.bridge.ask("Approve?", 60_000, turn.signal);
  await waitFor(() => h.api.sent.length > 0, "the question");
  turn.abort();
  expect(await within(2000, answer)).toEqual({ asked: true, text: null });

  // The slot is clear, so the next call is asked rather than refused as a duplicate — a stale
  // continuation left behind would have swallowed this one's answer.
  const next = h.bridge.ask("And this?", 2000);
  await waitFor(() => h.api.sent.length > 1, "the second question");
  h.api.push(message({ text: "yes" }));
  expect(await within(2000, next)).toEqual({ asked: true, text: "yes" });
  h.bridge.stop();
});

test("a signal already aborted is not waited on at all", async () => {
  const h = harness();
  h.bridge.start();
  expect(await within(2000, h.bridge.ask("Approve?", 60_000, AbortSignal.abort()))).toEqual({
    asked: true,
    text: null,
  });
  h.bridge.stop();
});

/** A gate holding a promise across shutdown is a tool call that never returns. */
test("stopping releases a pending question", async () => {
  const h = harness();
  h.bridge.start();
  const answer = h.bridge.ask("Approve?", 60_000);
  await waitFor(() => h.api.sent.length > 0, "the question");
  h.bridge.stop();
  expect(await within(2000, answer)).toEqual({ asked: true, text: null });
});

// ---------------------------------------------------------------------------
// Staying up.
// ---------------------------------------------------------------------------

test("a failed poll is retried, and reported only once it is persistent", async () => {
  const h = harness({}, [[], [message({ text: "after the outage" })]]);
  h.api.breakFor(4);
  h.bridge.start();
  await waitFor(() => h.delivered.length > 0, "recovery");
  h.bridge.stop();

  expect(h.delivered).toEqual(["after the outage"]);
  const warned = h.notices.filter((n) => n.level === "warning");
  // Not on the first failure — a laptop that slept recovers on its own — and not once per
  // failure either.
  expect(warned).toHaveLength(1);
  expect(h.notices.some((n) => n.level === "info" && n.msg.includes("reconnected"))).toBe(true);
});

test("backoff grows and then stops growing", () => {
  expect(backoffFor(1)).toBe(2000);
  expect(backoffFor(2)).toBe(4000);
  expect(backoffFor(3)).toBe(8000);
  // Capped, so a network that is gone for an hour is not polled a thousand times.
  expect(backoffFor(50)).toBe(60_000);
  expect(backoffFor(50)).toBe(backoffFor(6));
});

test("start is idempotent, and stop is safe to call twice", () => {
  const h = harness();
  h.bridge.start();
  h.bridge.start();
  expect(h.bridge.listening()).toBe(true);
  h.bridge.stop();
  h.bridge.stop();
  expect(h.bridge.listening()).toBe(false);
});

// ---------------------------------------------------------------------------
// Outbound.
// ---------------------------------------------------------------------------

test("say posts to the authorised chat, and reports having nowhere to post", async () => {
  const h = harness();
  expect(await h.bridge.say("done")).toBe(true);
  expect(h.api.sent).toEqual(["done"]);
  expect(await harness({ chat: "" }).bridge.say("done")).toBe(false);
  expect(await harness({ token: "" }).bridge.say("done")).toBe(false);
});

test("a send failure is reported rather than thrown at the caller", async () => {
  const h = harness();
  h.api.breakFor(1);
  const broken = createBridge({
    loadConfig: () => ({ ...DEFAULTS, token: "T", chat: "42" }),
    fetch: () => Promise.reject(new Error("no route to host")),
    deliver: () => {},
    notify: (msg, level) => h.notices.push({ msg, level }),
  });
  expect(await broken.say("done")).toBe(false);
  expect(h.notices.at(-1)!.level).toBe("error");
});

test("a message over Telegram's limit is cut rather than rejected whole", () => {
  const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
  const fitted = fitMessage(long);
  expect(fitted.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  expect(fitted).toContain("truncated");
  // Anything that fits round-trips exactly, marker and all.
  expect(fitMessage("short")).toBe("short");
});
