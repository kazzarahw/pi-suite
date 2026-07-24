import { test, expect } from "bun:test";
import { pendingReminder, nudgeAction } from "../src/nudge.ts";

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

test("nudgeAction never nudges without an interactive UI (one-shot guard)", () => {
  // The 72-minute hang: nudging in -p/JSON mode stalls Pi's exit.
  expect(nudgeAction("notify", false, true)).toBe("none");
  expect(nudgeAction("block", false, true)).toBe("none");
});

test("nudgeAction maps mode to action when interactive with pending work", () => {
  expect(nudgeAction("notify", true, true)).toBe("remind");
  expect(nudgeAction("block", true, true)).toBe("continue");
  expect(nudgeAction("off", true, true)).toBe("none");
  expect(nudgeAction("notify", true, false)).toBe("none"); // nothing pending
});
