import { test, expect } from "bun:test";
import { assistantText, shouldRelay } from "../src/relay.ts";

test("the prose of an assistant message is joined out of its text parts", () => {
  expect(
    assistantText({
      role: "assistant",
      content: [
        { type: "text", text: "all " },
        { type: "text", text: "done" },
      ],
    }),
  ).toBe("all done");
});

/**
 * A mid-turn message is usually tool calls and thinking, and relaying those would send a stream
 * of blank messages to someone's phone.
 *
 * Thinking is excluded rather than merely unhandled: it is not the answer, and it is not something
 * to push to a phone.
 */
test("a message with no prose relays nothing", () => {
  expect(
    assistantText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me check the file" },
        { type: "toolCall", name: "read", arguments: {} },
      ],
    }),
  ).toBeNull();
  expect(assistantText({ role: "assistant", content: [{ type: "text", text: "   " }] })).toBeNull();
});

test("only the assistant's own messages are relayed", () => {
  expect(assistantText({ role: "user", content: "run the tests" })).toBeNull();
  expect(assistantText({ role: "toolResult", content: [{ type: "text", text: "ok" }] })).toBeNull();
  expect(assistantText(undefined)).toBeNull();
  expect(assistantText({ role: "assistant" })).toBeNull();
});

test("a string content is accepted, as spawn's reader already does", () => {
  expect(assistantText({ role: "assistant", content: "done" })).toBe("done");
  expect(assistantText({ role: "assistant", content: "  " })).toBeNull();
});

// ---------------------------------------------------------------------------
// When to relay.
// ---------------------------------------------------------------------------

/**
 * The default answers only what Telegram asked.
 *
 * Someone at the keyboard is already reading the reply, and mirroring every local answer to their
 * phone is notification spam that trains them to ignore the one that matters.
 */
test("telegram mode replies only to turns Telegram started", () => {
  expect(shouldRelay("telegram", true)).toBe(true);
  expect(shouldRelay("telegram", false)).toBe(false);
});

test("always replies to every turn, whoever started it", () => {
  expect(shouldRelay("always", true)).toBe(true);
  expect(shouldRelay("always", false)).toBe(true);
});

test("off replies to nothing, including its own turns", () => {
  expect(shouldRelay("off", true)).toBe(false);
  expect(shouldRelay("off", false)).toBe(false);
});
