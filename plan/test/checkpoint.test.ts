import { test, expect } from "bun:test";
import { checkpointFor } from "../src/checkpoint.ts";
import {
  applyItems,
  applyObjective,
  applyStart,
  applyStep,
  emptyPlan,
  type Plan,
} from "../src/state.ts";

const withItems = (): Plan =>
  applyObjective(
    applyItems(emptyPlan(), [{ content: "validate the handlers" }, { content: "add the tests" }])
      .plan,
    { objective: "harden the api" },
  ).plan;

const objectiveOnly = (): Plan =>
  applyObjective(emptyPlan(), { objective: "harden the api" }).plan;

/** An item active with the worksheet it was started on. */
const started = (steps?: string[]): Plan =>
  applyStart(withItems(), "1", "read the handlers first", steps).plan;

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

/**
 * The resolution prompt also names the next item.
 *
 * Asking only "does this change the list?" left the other live option unnamed, and a
 * dogfooded session took it badly: it answered the question, then called `start` on an item
 * it had already finished with the approach "Already done - test was added and passes".
 * Revising and advancing are both available here, and the choice is being made right now.
 */
test("resolving an item also names the next one to start", () => {
  const text = checkpointFor("finish", withItems())!;
  expect(text).toContain('action "start"');
  expect(text).toContain('1 ("validate the handlers")');
});

test("it says who is speaking, like everything else pi-plan shows the model", () => {
  expect(checkpointFor("finish", withItems())!.startsWith("[pi-plan] ")).toBe(true);
  expect(checkpointFor("finish", objectiveOnly())!.startsWith("[pi-plan] ")).toBe(true);
  expect(checkpointFor("start", withItems())!.startsWith("[pi-plan] ")).toBe(true);
});

test("the last item resolved turns the question to the objective", () => {
  const text = checkpointFor("finish", objectiveOnly())!;
  expect(text).toContain('Is "harden the api" achieved?');
  expect(text).toContain('status "met"');
  // The omission that `requireFields` now permits is worth naming where it is useful: the
  // dogfooded session that hit this resent the whole objective sentence to say one word.
  expect(text).toContain("may be omitted");
});

// ---------------------------------------------------------------------------
// Every other call gets the transition that is legal from here.
//
// The list shows what exists; it does not show which verb the state will accept, and the
// lifecycle is the whole abstraction. A session that knew all eight verbs still ticked a
// step of an empty worksheet, started a second item over an active one, and passed an id
// to `finish` — all legal-shaped, all wrong for the state they were made in.
// ---------------------------------------------------------------------------

test("with nothing active, the next call is start, with the id to use", () => {
  for (const action of ["objective", "items", "add", "step", "promote"]) {
    const text = checkpointFor(action, withItems())!;
    expect(text).toContain('action "start"');
    expect(text).toContain('1 ("validate the handlers")');
  }
});

test("with an unticked step, the next call is that step", () => {
  const text = checkpointFor("start", started(["read handler A", "read handler B"]))!;
  expect(text).toContain('"read handler A" is the first unticked step');
  expect(text).toContain('action "step"');
  // Named so the agent knows what ends the item, not only what continues it.
  expect(text).toContain('action "finish"');
});

test("with every step ticked, the next call is a resolution", () => {
  const ticked = applyStep(applyStep(started(["one", "two"]), { index: 0, done: true }).plan, {
    index: 1,
    done: true,
  }).plan;
  const text = checkpointFor("step", ticked)!;
  expect(text).toContain("Every step is ticked");
  expect(text).toContain('action "finish"');
  expect(text).toContain('action "drop"');
});

/**
 * An item started with no `steps` is resolvable *and* has nowhere to tick.
 *
 * The same position in the lifecycle as a fully ticked worksheet, but it needs the other
 * sentence: `start` takes `steps` optionally, and the agent that assumed otherwise spent two
 * calls on `no step at index 0 (the worksheet has 0)` without ever being told that `step`
 * also appends.
 */
test("with no worksheet at all, appending one is offered alongside resolving", () => {
  const text = checkpointFor("start", started())!;
  expect(text).toContain("no worksheet");
  expect(text).toContain('action "step"');
  expect(text).toContain('action "finish"');
});

test("with an objective and no items, the next call is items", () => {
  const text = checkpointFor("objective", objectiveOnly())!;
  expect(text).toContain('action "items"');
  expect(text).toContain("harden the api");
});

/**
 * Nothing recorded, and nothing resolved either: the first call is a declaration.
 *
 * This branch used to be silence, on the argument that there was nothing to ask about. That
 * is true of the *question* and false of the guidance — an empty plan is exactly the state in
 * which naming the entry point is worth something.
 */
test("an empty plan names the entry point rather than saying nothing", () => {
  for (const plan of [
    emptyPlan(),
    applyObjective(emptyPlan(), { objective: "harden the api", status: "met" }).plan,
  ]) {
    for (const action of ["finish", "objective"]) {
      const text = checkpointFor(action, plan)!;
      expect(text).toContain('action "objective"');
      expect(text).toContain('action "items"');
    }
  }
});

test("one open item is not pluralised", () => {
  const one = applyItems(emptyPlan(), [{ content: "the last thing" }]).plan;
  expect(checkpointFor("drop", one)).toContain("1 item still open");
});

/**
 * One line, on every call.
 *
 * The budget is the reason this is readable at all: it rides every single result, and
 * anything that grows into a paragraph becomes wallpaper. Asserted rather than described,
 * because a later branch is exactly how a line becomes three.
 */
test("the line stays one line", () => {
  const plans: Plan[] = [
    emptyPlan(),
    objectiveOnly(),
    withItems(),
    started(),
    started(["a", "b"]),
  ];
  for (const plan of plans) {
    for (const action of ["objective", "items", "add", "start", "step", "promote", "finish", "drop"]) {
      const text = checkpointFor(action, plan);
      expect(text).not.toBeNull();
      expect(text!).not.toContain("\n");
    }
  }
});
