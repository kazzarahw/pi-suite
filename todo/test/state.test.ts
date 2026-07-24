import { test, expect } from "bun:test";
import { applyWrite } from "../src/state.ts";

test("applyWrite assigns non-empty ids to new items, preserving order", () => {
  const { todos } = applyWrite([], [
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
  ]);
  expect(todos.map((t) => t.content)).toEqual(["a", "b"]);
  expect(todos.every((t) => typeof t.id === "string" && t.id.length > 0)).toBe(true);
});

test("applyWrite preserves an item's id across writes matched by content", () => {
  const first = applyWrite([], [{ content: "task", status: "pending" }]).todos;
  const second = applyWrite(first, [{ content: "task", status: "in_progress" }]).todos;
  expect(second[0]!.id).toBe(first[0]!.id);
  expect(second[0]!.status).toBe("in_progress");
});

test("applyWrite reports items newly transitioned to done", () => {
  const prev = applyWrite([], [
    { content: "x", status: "in_progress" },
    { content: "y", status: "pending" },
  ]).todos;
  const { newlyCompleted } = applyWrite(prev, [
    { id: prev[0]!.id, content: "x", status: "done" },
    { id: prev[1]!.id, content: "y", status: "pending" },
  ]);
  expect(newlyCompleted.map((t) => t.content)).toEqual(["x"]);
});

test("applyWrite does not re-report an already-done item", () => {
  const prev = applyWrite([], [{ content: "x", status: "done" }]).todos;
  const { newlyCompleted } = applyWrite(prev, [{ id: prev[0]!.id, content: "x", status: "done" }]);
  expect(newlyCompleted).toEqual([]);
});
