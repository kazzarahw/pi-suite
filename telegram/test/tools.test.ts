import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTelegramTool, describeCall } from "../src/tools.ts";
import {
  formatMessage,
  formatMessages,
  formatChat,
  formatChats,
  type FetchFn,
  type TelegramMessage,
  type TelegramChat,
} from "../src/telegram.ts";

const ctx = {} as unknown as ExtensionContext;
const CONFIG = { token: "123456:AAH-token", defaultChat: "" };

/** A fetch that replays one canned `ok` body per call. */
function okFetch(...results: unknown[]): FetchFn {
  let i = 0;
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: results[Math.min(i++, results.length - 1)] }),
  });
}

const tool = (fetch: FetchFn, config = CONFIG) =>
  buildTelegramTool({ loadConfig: () => config, fetch });

const textOf = (r: { content: unknown[] }): string => (r.content[0] as { text: string }).text;

const message = (over: Record<string, unknown>) => ({
  message_id: 1,
  date: 1700000000,
  text: "hi",
  chat: { id: 5, type: "private" },
  ...over,
});

// ---------------------------------------------------------------------------
// describeCall — the tool-call summary line
// ---------------------------------------------------------------------------

test("describeCall shows action and chat_id for send", () => {
  expect(
    describeCall({ action: "send", chat_id: "@user", text: "hello" }),
  ).toBe('send @user "hello"');
});

test("describeCall truncates long text", () => {
  const longText = "a".repeat(50);
  const result = describeCall({
    action: "send",
    chat_id: "123",
    text: longText,
  });
  expect(result).toBe('send 123 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…"');
  expect(result.length).toBeLessThan(60);
});

test("describeCall shows action and chat_id for read", () => {
  expect(describeCall({ action: "read", chat_id: "123" })).toBe("read 123");
});

test("describeCall shows action only for list", () => {
  expect(describeCall({ action: "list" })).toBe("list");
});

test("describeCall shows action and chat_id for chat", () => {
  expect(describeCall({ action: "chat", chat_id: "@bot", text: "hi" })).toBe(
    'chat @bot "hi"',
  );
});

// ---------------------------------------------------------------------------
// formatMessage — one message to a readable line
// ---------------------------------------------------------------------------

const sampleMsg: TelegramMessage = {
  message_id: 42,
  from: { id: 1, first_name: "Alice", username: "alice42" },
  chat: { id: -100, type: "group", title: "Test Group" },
  text: "Hello, world!",
  date: 1700000000,
};

test("formatMessage includes username, date, and text", () => {
  const result = formatMessage(sampleMsg);
  expect(result).toContain("@alice42");
  expect(result).toContain("Hello, world!");
  expect(result).toContain("2023-11-14"); // 1700000000 is Nov 14 2023
});

test("formatMessage falls back to first_name when no username", () => {
  const noUser = { ...sampleMsg, from: { id: 1, first_name: "Bob" } };
  const result = formatMessage(noUser);
  expect(result).toContain("Bob");
  expect(result).not.toContain("@");
});

test("formatMessage shows '(no text)' for messages without text", () => {
  const noText = { ...sampleMsg, text: undefined };
  const result = formatMessage(noText);
  expect(result).toContain("(no text)");
});

// ---------------------------------------------------------------------------
// formatMessages — a list of messages
// ---------------------------------------------------------------------------

test("formatMessages returns '(no messages)' for empty list", () => {
  expect(formatMessages([])).toBe("(no messages)");
});

test("formatMessages joins messages with newlines", () => {
  const msgs = [
    { ...sampleMsg, message_id: 1, text: "first" },
    { ...sampleMsg, message_id: 2, text: "second" },
  ];
  const result = formatMessages(msgs);
  expect(result).toContain("first");
  expect(result).toContain("second");
  expect(result.split("\n").length).toBe(2);
});

// ---------------------------------------------------------------------------
// formatChat — one chat to a readable line
// ---------------------------------------------------------------------------

const sampleChat: TelegramChat = {
  id: -100,
  type: "group",
  title: "Test Group",
  last_message: "Hello!",
  last_date: 1700000000,
};

test("formatChat shows title, type, id, and preview", () => {
  const result = formatChat(sampleChat);
  expect(result).toContain("Test Group");
  expect(result).toContain("group");
  expect(result).toContain("-100");
  expect(result).toContain("Hello!");
});

test("formatChat shows DM for private chats", () => {
  const dm = {
    ...sampleChat,
    type: "private" as const,
    title: undefined,
    first_name: "Alice",
  };
  const result = formatChat(dm);
  expect(result).toContain("DM");
  expect(result).toContain("Alice");
});

// ---------------------------------------------------------------------------
// formatChats — a list of chats
// ---------------------------------------------------------------------------

test("formatChats returns '(no recent chats)' for empty list", () => {
  expect(formatChats([])).toBe("(no recent chats)");
});

test("formatChats numbers the entries", () => {
  const chats: TelegramChat[] = [
    { id: 1, type: "private", first_name: "Alice", last_date: 100 },
    { id: 2, type: "group", title: "Group", last_date: 200 },
  ];
  const result = formatChats(chats);
  expect(result).toMatch(/^1\. /m);
  expect(result).toMatch(/^2\. /m);
});

// ---------------------------------------------------------------------------
// execute — the dispatch, and what each action hands back to the agent
// ---------------------------------------------------------------------------

test("list reports the chats the bot has seen", async () => {
  const t = tool(okFetch([{ message: message({ text: "yo" }) }]));
  const r = await t.execute("id", { action: "list" }, undefined, undefined, ctx);
  expect(textOf(r)).toContain("id: 5");
  expect(r.details).toEqual({ action: "list", chat_id: undefined });
});

test("send names the chat and the message it created", async () => {
  const t = tool(okFetch(message({ message_id: 99 })));
  const r = await t.execute(
    "id",
    { action: "send", chat_id: "@alice", text: "hello" },
    undefined,
    undefined,
    ctx,
  );
  expect(textOf(r)).toBe("Sent to @alice (message 99)");
  expect(r.details).toEqual({ action: "send", chat_id: "@alice" });
});

test("read renders the messages, and says so plainly when there are none", async () => {
  const withSome = tool(okFetch([{ message: message({ text: "howdy" }) }]));
  expect(
    textOf(await withSome.execute("id", { action: "read", chat_id: "5" }, undefined, undefined, ctx)),
  ).toContain("howdy");

  const withNone = tool(okFetch([]));
  expect(
    textOf(await withNone.execute("id", { action: "read", chat_id: "5" }, undefined, undefined, ctx)),
  ).toBe("No recent messages from 5.");
});

test("chat reports the send and any replies", async () => {
  // The reply's id has to be *past* the send's: `chat` only counts messages newer than
  // the one it just posted, so that a chat's existing traffic is not reported as a reply.
  const t = tool(okFetch(message({ message_id: 7 }), [{ message: message({ message_id: 8, text: "sure" }) }]));
  // Already cancelled, so the reply wait short-circuits: the wait itself is covered in
  // telegram.test.ts, and this keeps the suite from sitting through 1.5s per call.
  const controller = new AbortController();
  controller.abort();
  const r = await t.execute(
    "id",
    { action: "chat", chat_id: "5", text: "ping" },
    controller.signal,
    undefined,
    ctx,
  );
  expect(textOf(r)).toContain("Sent to 5 (message 7)");
  expect(textOf(r)).toContain("sure");
});

test("chat says there is no reply yet rather than leaving it blank", async () => {
  const t = tool(okFetch(message({ message_id: 7 }), []));
  const controller = new AbortController();
  controller.abort();
  const r = await t.execute(
    "id",
    { action: "chat", chat_id: "5", text: "ping" },
    controller.signal,
    undefined,
    ctx,
  );
  expect(textOf(r)).toContain("(no reply yet)");
});

// ---------------------------------------------------------------------------
// What the tool refuses, and what it fills in
// ---------------------------------------------------------------------------

test("an action needing a chat falls back to defaultChat, then refuses", async () => {
  const withDefault = tool(okFetch([]), { ...CONFIG, defaultChat: "42" });
  const r = await withDefault.execute("id", { action: "read" }, undefined, undefined, ctx);
  expect(r.details.chat_id).toBe("42");

  const withNone = tool(okFetch([]));
  await expect(
    withNone.execute("id", { action: "read" }, undefined, undefined, ctx),
  ).rejects.toThrow(/'chat_id' is required/);
});

test("send and chat refuse without text rather than posting an empty message", async () => {
  const t = tool(okFetch(message({})));
  await expect(
    t.execute("id", { action: "send", chat_id: "5" }, undefined, undefined, ctx),
  ).rejects.toThrow(/"text" is required/);
  await expect(
    t.execute("id", { action: "chat", chat_id: "5" }, undefined, undefined, ctx),
  ).rejects.toThrow(/"text" is required/);
});

// ---------------------------------------------------------------------------
// Status, and the signal the tool used to drop
// ---------------------------------------------------------------------------

test("the tool reports progress and always clears it, including on failure", async () => {
  const status: Array<string | undefined> = [];
  const statusCtx = {
    ui: { setStatus: (_id: string, text?: string) => void status.push(text) },
  } as unknown as ExtensionContext;

  const t = tool(okFetch(message({})));
  await t.execute("id", { action: "send", chat_id: "5", text: "hi" }, undefined, undefined, statusCtx);
  expect(status[0]).toContain('send 5 "hi"');
  expect(status.at(-1)).toBeUndefined();

  status.length = 0;
  await expect(
    t.execute("id", { action: "send", chat_id: "5" }, undefined, undefined, statusCtx),
  ).rejects.toThrow();
  expect(status.at(-1)).toBeUndefined();
});

/**
 * The tool accepted an `AbortSignal` and passed it nowhere, so neither the user's cancel
 * nor any deadline could stop a request — the defect `shared/deadline.ts` was written
 * for, reintroduced. What reaches the request is the *combined* signal, so this asserts
 * the caller's cancel still propagates through it.
 */
test("the caller's signal reaches the request, by way of the deadline", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const fetch: FetchFn = async (_url, init) => {
    seen.push(init?.signal);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: message({}) }) };
  };

  const controller = new AbortController();
  const t = tool(fetch);
  await t.execute(
    "id",
    { action: "send", chat_id: "5", text: "hi" },
    controller.signal,
    undefined,
    ctx,
  );

  expect(seen[0]).toBeDefined();
  expect(seen[0]!.aborted).toBe(false);
  controller.abort();
  expect(seen[0]!.aborted).toBe(true);
});

test("a limit outside 1-100 is rejected rather than answered", async () => {
  // The schema's `minimum`/`maximum` are a hint the provider may act on; the tool cannot
  // rely on it. `params.limit ?? DEFAULT_LIMIT` passes a `0` straight through, and
  // `readMessages` answers `0` with `[]` — so the malformed call came back as "No recent
  // messages from 5", a confident claim about the chat rather than news about the call.
  const t = tool(okFetch([{ message: message({}) }]));
  for (const limit of [0, -1, 101, 2.5]) {
    await expect(
      t.execute("id", { action: "read", chat_id: "5", limit }, undefined, undefined, ctx),
    ).rejects.toThrow(/"limit" must be a whole number between 1 and 100/);
  }
});

test("an omitted limit still defaults rather than being rejected", async () => {
  const t = tool(okFetch([{ message: message({ text: "hi" }) }]));
  const r = await t.execute("id", { action: "read", chat_id: "5" }, undefined, undefined, ctx);
  expect(textOf(r)).toContain("hi");
});
