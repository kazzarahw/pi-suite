import { test, expect } from "bun:test";
import { eventToLine } from "../src/render.ts";

test("eventToLine renders each event kind concisely", () => {
  expect(eventToLine({ kind: "tool", text: "read" })).toContain("read");
  expect(eventToLine({ kind: "text", text: "  hello   world " })).toBe("hello world");
  expect(eventToLine({ kind: "final", text: "" })).toContain("done");
  expect(eventToLine({ kind: "error", text: "boom" })).toContain("boom");
});
