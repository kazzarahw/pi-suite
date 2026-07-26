import { test, expect } from "bun:test";
import { readProgress } from "../src/progress.ts";

test("reads done and total off a todo:updated payload", () => {
  const progress = readProgress({
    todos: [
      { id: "1", content: "a", status: "done" },
      { id: "2", content: "b", status: "in_progress" },
      { id: "3", content: "c", status: "pending" },
    ],
  });
  expect(progress).toEqual({ done: 1, total: 3 });
});

test("an empty list is null, not 0 of 0", () => {
  // "0 of 0 todos done" says less than saying nothing.
  expect(readProgress({ todos: [] })).toBeNull();
});

test("a malformed payload is null rather than a throw", () => {
  // The bus vocabulary is typed, but the publisher need not be the sibling that ships
  // today — a subscriber that throws on a surprise breaks the emitter's turn.
  expect(readProgress(undefined)).toBeNull();
  expect(readProgress(null)).toBeNull();
  expect(readProgress({})).toBeNull();
  expect(readProgress({ todos: "not an array" })).toBeNull();
  expect(readProgress({ todos: [null, undefined] })).toEqual({ done: 0, total: 2 });
});
