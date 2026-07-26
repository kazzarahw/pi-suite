import { test, expect } from "bun:test";
import { pendingReminder } from "../src/nudge.ts";

// `nudgeAction` moved to shared/ when pi-goal needed the same decision — it is covered
// once, in shared/test/nudge.test.ts. What stays here is the part that is pi-todo's:
// what counts as unfinished work, and how it is worded.

test("pendingReminder is null when the list is empty or fully done", () => {
  expect(pendingReminder([])).toBeNull();
  expect(pendingReminder([{ id: "1", content: "a", status: "done" }])).toBeNull();
});

test("pendingReminder names the in-progress task as the next step", () => {
  const msg = pendingReminder([
    { id: "1", content: "a", status: "done" },
    { id: "2", content: "b", status: "in_progress" },
    { id: "3", content: "c", status: "pending" },
  ]);
  expect(msg).toContain("b");
});

test("pendingReminder falls back to the first open item when none is in progress", () => {
  const msg = pendingReminder([
    { id: "1", content: "a", status: "done" },
    { id: "2", content: "b", status: "pending" },
  ]);
  expect(msg).toContain("b");
  expect(msg).toContain("1 todo(s)");
});
