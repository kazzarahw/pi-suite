import { test, expect } from "bun:test";
import { checkpointFor } from "../src/checkpoint.ts";
import { applyItems, applyObjective, emptyPlan, type Plan } from "../src/state.ts";

const withItems = (): Plan =>
  applyObjective(
    applyItems(emptyPlan(), [{ content: "validate the handlers" }, { content: "add the tests" }])
      .plan,
    { objective: "harden the api" },
  ).plan;

const objectiveOnly = (): Plan =>
  applyObjective(emptyPlan(), { objective: "harden the api" }).plan;

// ---------------------------------------------------------------------------
// Revision is an inaction, so it is asked about at the moment the agent takes a
// *related* action — resolving an item — rather than at settle, where the only shape
// available costs a turn and a quota.
// ---------------------------------------------------------------------------

test("resolving an item asks whether the rest of the list still holds", () => {
  for (const action of ["finish", "drop"]) {
    const text = checkpointFor(action, withItems())!;
    expect(text).toContain("2 items still open");
    expect(text).toContain("does what you just learned change any of them?");
    // Every route out is named, because "revise this" without the call is a complaint.
    expect(text).toContain('action "add"');
    expect(text).toContain('action "items"');
    expect(text).toContain('action "drop"');
  }
});

test("it says who is speaking, like everything else pi-plan shows the model", () => {
  expect(checkpointFor("finish", withItems())!.startsWith("[pi-plan] ")).toBe(true);
  expect(checkpointFor("finish", objectiveOnly())!.startsWith("[pi-plan] ")).toBe(true);
});

test("the last item resolved turns the question to the objective", () => {
  const text = checkpointFor("finish", objectiveOnly())!;
  expect(text).toContain('Is "harden the api" achieved?');
  expect(text).toContain('status "met"');
});

test("a met objective with nothing open says nothing", () => {
  const met = applyObjective(emptyPlan(), { objective: "harden the api", status: "met" }).plan;
  expect(checkpointFor("finish", met)).toBeNull();
});

test("an empty plan says nothing", () => {
  expect(checkpointFor("finish", emptyPlan())).toBeNull();
});

test("only resolutions are reflection points", () => {
  // `start` is committing to what was already decided, and `items`/`add` *are* the
  // revision — asking there would be re-asking a question just answered.
  for (const action of ["objective", "items", "add", "start", "step", "promote"]) {
    expect(checkpointFor(action, withItems())).toBeNull();
  }
});

test("one open item is not pluralised", () => {
  const one = applyItems(emptyPlan(), [{ content: "the last thing" }]).plan;
  expect(checkpointFor("drop", one)).toContain("1 item still open");
});
