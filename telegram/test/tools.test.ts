import { test, expect } from "bun:test";
import { describeCall } from "../src/tools.ts";
import {
  formatMessage,
  formatMessages,
  formatChat,
  formatChats,
  type TelegramMessage,
  type TelegramChat,
} from "../src/telegram.ts";

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
