import { test, expect } from "bun:test";
import { applySet, type Goal } from "../src/state.ts";

test("a first write records an active objective", () => {
  const { goal, newlyMet } = applySet(null, { objective: "ship the auth refactor" });
  expect(goal).toEqual({ objective: "ship the auth refactor", status: "active" });
  expect(newlyMet).toBe(false);
});

test("a new objective replaces the previous one wholesale", () => {
  const prev: Goal = { objective: "old", criteria: "old criteria", status: "active" };
  const { goal } = applySet(prev, { objective: "new" });
  // Criteria belong to the objective they were written for, not to the slot.
  expect(goal).toEqual({ objective: "new", status: "active" });
});

test("criteria carry forward when the same objective is restated without them", () => {
  const prev: Goal = { objective: "ship it", criteria: "tests pass", status: "active" };
  const { goal } = applySet(prev, { objective: "ship it", status: "met" });
  expect(goal.criteria).toBe("tests pass");
  expect(goal.status).toBe("met");
});

test("supplied criteria win over the carried-forward ones", () => {
  const prev: Goal = { objective: "ship it", criteria: "tests pass", status: "active" };
  const { goal } = applySet(prev, { objective: "ship it", criteria: "and deployed" });
  expect(goal.criteria).toBe("and deployed");
});

test("status carries forward too — restating a met objective does not reopen it", () => {
  // The asymmetry this pins: carrying `criteria` but defaulting `status` to "active"
  // made `goal({ objective })` on a met goal a silent regression, re-enabling the
  // injection and the settle nudges with nothing to signal it.
  const prev: Goal = { objective: "ship it", criteria: "tests pass", status: "met" };
  const { goal, newlyMet } = applySet(prev, { objective: "ship it", criteria: "amended" });
  expect(goal.status).toBe("met");
  expect(goal.criteria).toBe("amended");
  expect(newlyMet).toBe(false);
});

test("reopening a met objective is available, but has to be said", () => {
  const prev: Goal = { objective: "ship it", status: "met" };
  expect(applySet(prev, { objective: "ship it", status: "active" }).goal.status).toBe("active");
});

test("a brand-new objective is active even when the last one was met", () => {
  const prev: Goal = { objective: "old", status: "met" };
  expect(applySet(prev, { objective: "new" }).goal.status).toBe("active");
});

test("newlyMet fires on the active → met transition", () => {
  const prev: Goal = { objective: "ship it", status: "active" };
  expect(applySet(prev, { objective: "ship it", status: "met" }).newlyMet).toBe(true);
});

test("newlyMet is idempotent — restating a met objective reports nothing", () => {
  const prev: Goal = { objective: "ship it", status: "met" };
  expect(applySet(prev, { objective: "ship it", status: "met" }).newlyMet).toBe(false);
});

test("a different objective declared met is newly met, even after another was", () => {
  const prev: Goal = { objective: "ship it", status: "met" };
  expect(applySet(prev, { objective: "something else", status: "met" }).newlyMet).toBe(true);
});

test("the reducer does not mutate its input", () => {
  const prev: Goal = { objective: "ship it", criteria: "tests pass", status: "active" };
  const snapshot = structuredClone(prev);
  applySet(prev, { objective: "ship it", status: "met" });
  expect(prev).toEqual(snapshot);
});
