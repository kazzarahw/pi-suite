import { test, expect } from "bun:test";
import { planReminder } from "../src/nudge.ts";
import {
  applyFinish,
  applyItems,
  applyObjective,
  applyStart,
  applyStep,
  emptyPlan,
  type Plan,
} from "../src/state.ts";

const listed = (): Plan =>
  applyObjective(
    applyItems(emptyPlan(), [{ content: "design the state shape" }, { content: "write the tests" }])
      .plan,
    { objective: "merge todo and goal" },
  ).plan;

// The precedence is the lifecycle read backwards, which is what makes each reminder
// actionable rather than a general complaint.

test("an active item with unticked steps gets the next step named, and nothing else", () => {
  const plan = applyStep(
    applyStart(listed(), "1", "read both first", ["read them", "write it"]).plan,
    { index: 0, done: true },
  ).plan;
  const reminder = planReminder(plan)!;
  expect(reminder).toContain('Next step: "write it"');
  // Not told about the objective it is already working toward.
  expect(reminder).not.toContain("merge todo and goal");
});

test("an active item with every step ticked is asked to resolve it", () => {
  const plan = applyStep(applyStart(listed(), "1", "x", ["only step"]).plan, {
    index: 0,
    done: true,
  }).plan;
  const reminder = planReminder(plan)!;
  expect(reminder).toContain('action "finish"');
  expect(reminder).toContain('action "drop"');
});

test("an active item with no worksheet at all is asked to resolve it too", () => {
  const reminder = planReminder(applyStart(listed(), "1", "x").plan)!;
  expect(reminder).toContain('action "finish"');
});

test("items open with none active asks for start, an id, and an approach", () => {
  const reminder = planReminder(listed())!;
  expect(reminder).toContain("2 item(s) open and none active");
  expect(reminder).toContain('"design the state shape" (id 1)');
  expect(reminder).toContain("approach you are committing to before you edit");
});

test("an objective with nothing under it asks for the work to be laid out", () => {
  const plan = applyObjective(emptyPlan(), {
    objective: "merge todo and goal",
    criteria: "one extension",
  }).plan;
  const reminder = planReminder(plan)!;
  expect(reminder).toContain('Objective still open: "merge todo and goal"');
  expect(reminder).toContain("Met when: one extension.");
  expect(reminder).toContain('action "items"');
});

test("a passing verify is named in the objective reminder, as a question", () => {
  const plan = applyObjective(emptyPlan(), { objective: "ship it", criteria: "tests pass" }).plan;
  const reminder = planReminder(plan, { cmd: "bun test" })!;
  expect(reminder).toContain("`bun test` passed");
  // Evidence, put as a question. Whether passing checks satisfy *this* objective is a
  // judgement about intent, and it stays the agent's to make.
  expect(reminder).toContain("does that satisfy the criteria?");
});

test("the verify fragment never appears while item-level work is outstanding", () => {
  // It is evidence about the objective, and the agent working an item does not need it.
  expect(planReminder(listed(), { cmd: "bun test" })!).not.toContain("bun test");
});

test("nothing open and a met objective says nothing at all", () => {
  const done = applyFinish(applyStart(listed(), "1", "x").plan, "did it").plan;
  const emptied = applyItems(done, []).plan;
  const met = applyObjective(emptied, { objective: "merge todo and goal", status: "met" }).plan;
  expect(planReminder(met)).toBeNull();
});

test("an empty plan says nothing", () => {
  expect(planReminder(emptyPlan())).toBeNull();
});

test("a met objective with items still open still nudges about the items", () => {
  // The objective being declared met does not make the leftover work disappear, and
  // silence here would strand it.
  const met = applyObjective(listed(), { objective: "merge todo and goal", status: "met" }).plan;
  expect(planReminder(met)).toContain("none active");
});
