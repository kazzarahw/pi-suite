import { test, expect } from "bun:test";
import type { TodoItem } from "pi-shared";
import { appendState, restoreState } from "../src/persist.ts";

const todos = (n: string): TodoItem[] =>
  [{ id: n, content: `task ${n}`, status: "pending" }] as unknown as TodoItem[];

test("appendState writes a todo-state custom entry", () => {
  const calls: Array<{ type: string; data: unknown }> = [];
  appendState({ appendEntry: (type, data) => calls.push({ type, data }) }, todos("1"));
  expect(calls).toEqual([{ type: "todo-state", data: { todos: todos("1") } }]);
});

test("restoreState returns [] when there is no branch", () => {
  expect(restoreState({})).toEqual([]);
  expect(restoreState({ sessionManager: null })).toEqual([]);
});

test("restoreState rebuilds from the most recent todo-state entry, ignoring other entries", () => {
  const branch = [
    { type: "custom", customType: "todo-state", data: { todos: todos("old") } },
    { type: "message", customType: "chat", data: {} },
    { type: "custom", customType: "todo-state", data: { todos: todos("new") } },
    { type: "custom", customType: "other", data: { todos: todos("nope") } },
  ];
  expect(restoreState({ sessionManager: { getBranch: () => branch } })).toEqual(todos("new"));
});

test("restoreState returns [] when the latest entry's payload is malformed", () => {
  const branch = [{ type: "custom", customType: "todo-state", data: { todos: "not-an-array" } }];
  expect(restoreState({ sessionManager: { getBranch: () => branch } })).toEqual([]);
});
