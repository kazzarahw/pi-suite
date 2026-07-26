import { test, expect } from "bun:test";
import { goalReminder } from "../src/nudge.ts";
import type { Goal } from "../src/state.ts";

const active: Goal = { objective: "ship the auth refactor", status: "active" };

test("no reminder without an objective, or once it is met", () => {
  expect(goalReminder(null, null, null)).toBeNull();
  expect(goalReminder({ ...active, status: "met" }, null, null)).toBeNull();
});

test("the reminder names the objective and how to close it out", () => {
  const msg = goalReminder(active, null, null)!;
  expect(msg).toContain("ship the auth refactor");
  expect(msg).toContain("goal_set");
  expect(msg).toContain("met");
});

test("the reminder carries the criteria and the todo progress when there are any", () => {
  const msg = goalReminder({ ...active, criteria: "tokens rotate cleanly" }, { done: 2, total: 5 }, null)!;
  expect(msg).toContain("Met when: tokens rotate cleanly.");
  expect(msg).toContain("2 of 5 todos done.");
});

test("the reminder omits progress when nothing publishes it", () => {
  expect(goalReminder(active, null, null)).not.toContain("todos done");
});
