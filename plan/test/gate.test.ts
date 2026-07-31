import { test, expect } from "bun:test";
import { gateEdit } from "../src/gate.ts";
import {
  applyClear,
  applyItems,
  applyObjective,
  applyStart,
  emptyPlan,
  type Plan,
} from "../src/state.ts";

const listed = (): Plan =>
  applyObjective(applyItems(emptyPlan(), [{ content: "design the state shape" }]).plan, {
    objective: "merge todo and goal",
  }).plan;

const active = (): Plan => applyStart(listed(), "1", "read both extensions first").plan;

test("only block mode refuses anything", () => {
  for (const mode of ["off", "notify"] as const) {
    expect(gateEdit(listed(), mode, "write").block).toBe(false);
  }
  expect(gateEdit(listed(), "block", "write").block).toBe(true);
});

test("only the tools that write to disk are gated", () => {
  // The set comes from shared/tool-input.ts rather than being redefined here: pi-git and
  // pi-lens once disagreed about which tools write, and a third opinion is how the next
  // silent gap gets introduced.
  for (const tool of ["read", "grep", "find", "ls", "bash"]) {
    expect(gateEdit(listed(), "block", tool).block).toBe(false);
  }
  for (const tool of ["write", "edit"]) {
    expect(gateEdit(listed(), "block", tool).block).toBe(true);
  }
});

// THE usability constraint. Without the arm condition, installing pi-plan means no edit
// works until the tool has been called, so every one-line session becomes ceremony and the
// first thing any user does is turn the mode back down.
test("an empty plan is not a violated plan — nothing is gated before one exists", () => {
  expect(gateEdit(emptyPlan(), "block", "write").block).toBe(false);
});

test("an objective alone arms the gate, and so does a list alone", () => {
  const objectiveOnly = applyObjective(emptyPlan(), { objective: "ship it" }).plan;
  expect(gateEdit(objectiveOnly, "block", "write").block).toBe(true);

  const itemsOnly = applyItems(emptyPlan(), [{ content: "a" }]).plan;
  expect(gateEdit(itemsOnly, "block", "write").block).toBe(true);
});

test("an active item with an approach is what the gate is asking for", () => {
  expect(gateEdit(active(), "block", "write")).toEqual({ block: false });
});

test("clearing the plan disarms the gate — the escape hatch has to actually work", () => {
  expect(gateEdit(applyClear(active()).plan, "block", "write").block).toBe(false);
});

// ---------------------------------------------------------------------------
// What it says when it refuses. A refusal the agent cannot act on is just a wall.
// ---------------------------------------------------------------------------

test("the refusal names the tool call to make, and the next item by id", () => {
  const decision = gateEdit(listed(), "block", "edit");
  expect(decision.block).toBe(true);
  expect(decision.reason).toContain("[pi-plan]");
  expect(decision.reason).toContain('action "start"');
  // One spelling for naming an item, shared with the reducers, the reminder, and the
  // checkpoint — see `itemLabel`. This file used to write its own third variant.
  expect(decision.reason).toContain('1 ("design the state shape")');
});

test("an objective with no plan under it gets its own wording", () => {
  const objectiveOnly = applyObjective(emptyPlan(), { objective: "ship it" }).plan;
  const decision = gateEdit(objectiveOnly, "block", "write");
  expect(decision.reason).toContain('action "items"');
});

test("an active item with no approach is refused rather than trusted", () => {
  // `applyStart` cannot produce this and `restoreState` demotes one that arrives that way,
  // so it is unreachable in practice — and handled anyway, because "unreachable" is a
  // claim about today's code and this is a refusal.
  const impossible: Plan = {
    ...listed(),
    items: [{ id: "1", content: "design the state shape", status: "active" }],
  };
  const decision = gateEdit(impossible, "block", "write");
  expect(decision.block).toBe(true);
  expect(decision.reason).toContain("no approach");
  expect(decision.reason).toContain("id 1");
});

test("every refusal leads with the fact that the write did not happen", () => {
  // From the model's side the tool call has already been made, payload and all, and Pi
  // renders it that way. Dogfooding watched an agent read a refusal as advice about what
  // to do next rather than news about what had happened — "the README.md was already
  // written by the earlier write call" — and go looking for a file that did not exist.
  // Saying only *why* leaves the agent to infer *whether*, and it inferred wrong.
  const objectiveOnly = applyObjective(emptyPlan(), { objective: "ship it" }).plan;
  const noApproach: Plan = {
    ...listed(),
    items: [{ id: "1", content: "design the state shape", status: "active" }],
  };

  for (const plan of [listed(), objectiveOnly, noApproach]) {
    const reason = gateEdit(plan, "block", "write").reason!;
    expect(reason.startsWith("[pi-plan] this edit did NOT happen")).toBe(true);
    expect(reason).toContain("the file is unchanged");
    // …and the write still needs making once the plan is in order.
    expect(reason).toContain("Then make this edit again.");
  }
});

test("the plan tool itself can never be gated", () => {
  // EDIT_TOOLS holds `write` and `edit`, so the tool that resolves a refusal is not in the
  // set that produces one. Pinned because the alternative is an unrecoverable session.
  expect(gateEdit(listed(), "block", "plan").block).toBe(false);
});
