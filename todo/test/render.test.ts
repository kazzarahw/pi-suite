import { test, expect } from "bun:test";
import { renderTodos, formatInjection } from "../src/render.ts";

test("renderTodos returns one marked line per todo in order", () => {
  const lines = renderTodos([
    { id: "1", content: "a", status: "done" },
    { id: "2", content: "b", status: "pending" },
  ]);
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("a");
  expect(lines[1]).toContain("b");
});

test("formatInjection returns empty string for an empty list", () => {
  expect(formatInjection([])).toBe("");
});

test("formatInjection wraps the list in a <pi-todo> block", () => {
  const out = formatInjection([{ id: "1", content: "ship it", status: "pending" }]);
  expect(out).toContain("<pi-todo>");
  expect(out).toContain("</pi-todo>");
  expect(out).toContain("ship it");
});
