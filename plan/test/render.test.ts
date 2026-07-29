import { test, expect } from "bun:test";
import { renderPlan, formatInjection, formatResume } from "../src/render.ts";
import {
  applyDrop,
  applyFinish,
  applyItems,
  applyObjective,
  applyStart,
  applyStep,
  emptyPlan,
  type Plan,
} from "../src/state.ts";

const planned = (): Plan =>
  applyObjective(
    applyItems(emptyPlan(), [{ content: "design the state shape" }, { content: "write the tests" }])
      .plan,
    { objective: "merge todo and goal into one plan" },
  ).plan;

const working = (): Plan =>
  applyStep(applyStart(planned(), "1", "read both extensions first", ["read both", "write it"]).plan, {
    index: 0,
    done: true,
  }).plan;

// ---------------------------------------------------------------------------
// The widget — everything volatile, because it is free.
// ---------------------------------------------------------------------------

test("the widget shows the objective, a tally, the open list, and the active worksheet", () => {
  expect(renderPlan(working())).toEqual([
    "▸ merge todo and goal into one plan",
    "  2 open",
    "1. ◐ design the state shape",
    "     ▣ read both",
    "     ▢ write it",
    "2. ▢ write the tests",
  ]);
});

test("items are labelled by id, not position — the id is what the agent types back", () => {
  const plan = applyDrop(planned(), "1", "not needed").plan;
  expect(renderPlan(plan).at(-1)).toBe("2. ▢ write the tests");
});

test("the tally counts done, dropped, and open, omitting what is zero", () => {
  expect(renderPlan(planned())[1]).toBe("  2 open");
  const resolved = applyFinish(applyStart(planned(), "1", "x").plan, "did it").plan;
  expect(renderPlan(resolved)[1]).toBe("  1 done · 1 open");
  const both = applyDrop(resolved, "2", "unnecessary").plan;
  expect(renderPlan(both)[1]).toBe("  1 done · 1 dropped");
});

test("a met objective keeps its tick in the widget", () => {
  const met = applyObjective(planned(), {
    objective: "merge todo and goal into one plan",
    status: "met",
  }).plan;
  expect(renderPlan(met)[0]).toBe("✓ merge todo and goal into one plan");
});

test("a passing verify folds into the tally when something published one", () => {
  expect(renderPlan(planned(), { cmd: "bun test" })[1]).toBe("  2 open · verify ✓");
  expect(renderPlan(planned(), null)[1]).not.toContain("verify");
});

test("an empty plan renders nothing at all", () => {
  expect(renderPlan(emptyPlan())).toEqual([]);
});

// A rendered line wider than the terminal crashes Pi outright with "Rendered line N
// exceeds terminal width". pi-goal clipped its one line; a plan draws as many lines as the
// work has parts, and every one of them carries agent-authored text of any length.
test("every widget line is clipped, not just the objective", () => {
  const long = "x".repeat(300);
  const plan = applyStart(
    applyObjective(applyItems(emptyPlan(), [{ content: long }]).plan, { objective: long }).plan,
    "1",
    "an approach",
    [long],
  ).plan;
  const lines = renderPlan(plan, { cmd: "bun test" });
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(88);
  expect(lines[0]!.endsWith("…")).toBe(true);
});

// ---------------------------------------------------------------------------
// THE prompt-cache guard. The standing block is prepended to every LLM call, so it sits at
// message index 0, while the provider's conversation-history cache breakpoint goes on the
// LAST user message — a hit needs the whole prefix to match. Anything in here that moves as
// the work moves invalidates the entire conversation cache on every call, in exactly the
// long sessions this extension exists for. This property has no other guard.
// ---------------------------------------------------------------------------

test("the standing block does not change as items move, steps tick, or the log grows", () => {
  const base = applyStart(planned(), "1", "read both extensions first").plan;
  const first = formatInjection(base);

  // Ticking a worksheet.
  const ticked = applyStep(applyStep(base, { steps: ["a", "b"] }).plan, { index: 0, done: true }).plan;
  expect(formatInjection(ticked)).toBe(first);

  // Rewriting the open list around the active item.
  const rewritten = applyItems(ticked, [
    { content: "design the state shape" },
    { content: "write the tests" },
    { content: "something discovered later" },
  ]).plan;
  expect(formatInjection(rewritten)).toBe(first);

  // And the log growing, which is the one that would have grown without bound.
  let grown = rewritten;
  for (let i = 0; i < 20; i++) {
    grown = applyDrop(applyItems(grown, [
      ...grown.items.map((it) => ({ id: it.id, content: it.content })),
      { content: `extra ${i}` },
    ]).plan, String(grown.seq), `not needed ${i}`).plan;
  }
  expect(grown.log).toHaveLength(20);
  expect(formatInjection(grown)).toBe(first);
});

test("the standing block carries no counts, no list, and no log", () => {
  const resolved = applyFinish(
    applyStart(planned(), "1", "read both extensions first").plan,
    "landed cleanly",
  ).plan;
  const block = formatInjection(resolved);
  expect(block).not.toContain("open");
  expect(block).not.toContain("done");
  expect(block).not.toContain("landed cleanly");
  expect(block).not.toContain("write the tests");
});

test("the standing block is a tagged block carrying the objective, criteria, and active work", () => {
  const plan = applyStart(
    applyObjective(planned(), {
      objective: "merge todo and goal into one plan",
      criteria: "one extension, one tool",
    }).plan,
    "1",
    "read both extensions first",
  ).plan;
  const block = formatInjection(plan);
  expect(block.startsWith("<pi-plan>\nplan · objective and current work\n")).toBe(true);
  expect(block.endsWith("</pi-plan>")).toBe(true);
  expect(block).toContain("▸ merge todo and goal into one plan");
  expect(block).toContain("  met when: one extension, one tool");
  expect(block).toContain("◐ in progress: design the state shape");
  expect(block).toContain("  approach: read both extensions first");
});

test("the standing block changes when the agent advances — that is what it is for", () => {
  const before = formatInjection(planned());
  const after = formatInjection(applyStart(planned(), "1", "read both extensions first").plan);
  expect(after).not.toBe(before);
});

test("a met objective with nothing active stops being injected", () => {
  // It is finished; repeating it for the rest of the session costs context on every call
  // and buys nothing. The widget keeps the ✓.
  const met = applyObjective(applyItems(planned(), []).plan, {
    objective: "merge todo and goal into one plan",
    status: "met",
  }).plan;
  expect(formatInjection(met)).toBe("");
});

test("there is no standing block before anything is planned", () => {
  expect(formatInjection(emptyPlan())).toBe("");
});

test("the standing block does not clip what the widget does", () => {
  // The clip is a terminal-width concern. The agent gets the whole sentence.
  const long = "x".repeat(200);
  expect(formatInjection(applyObjective(emptyPlan(), { objective: long }).plan)).toContain(long);
});

// ---------------------------------------------------------------------------
// The resume block — where the log finally reaches the agent.
// ---------------------------------------------------------------------------

test("the resume block carries the open list, the worksheet, and the approach", () => {
  const block = formatResume(working());
  expect(block).toContain("1. ◐ design the state shape");
  expect(block).toContain("approach: read both extensions first");
  expect(block).toContain("▣ read both");
  expect(block).toContain("2. ▢ write the tests");
});

// THE reason the log exists. A finish/drop echo lives in the transcript and dies at
// compaction — which is exactly when the agent forgets it already abandoned something.
test("dropped items and their reasons survive into the resume block, and are called out", () => {
  const dropped = applyDrop(planned(), "2", "the API already does this").plan;
  const block = formatResume(dropped);
  expect(block).toContain("do not re-propose");
  expect(block).toContain("✕ write the tests — the API already does this");
});

test("resolved items appear too, counted and marked apart from the dropped ones", () => {
  const resolved = applyFinish(applyStart(planned(), "1", "x").plan, "landed cleanly").plan;
  const block = formatResume(resolved);
  expect(block).toContain("resolved (1)");
  expect(block).toContain("▣ design the state shape — landed cleanly");
});

test("the resume block is bounded as the log grows without bound", () => {
  let plan = applyObjective(emptyPlan(), { objective: "a long session" }).plan;
  for (let i = 0; i < 60; i++) {
    plan = applyDrop(applyItems(plan, [{ content: `item ${i}` }]).plan, String(plan.seq), `reason ${i}`).plan;
  }
  expect(plan.log).toHaveLength(60);
  const lines = formatResume(plan).split("\n");
  // Capped, and showing the most recent rather than the oldest — a session's early
  // decisions matter least by the time it has made sixty of them.
  expect(lines.length).toBeLessThan(30);
  expect(formatResume(plan)).toContain("reason 59");
  expect(formatResume(plan)).not.toContain("reason 0 ");
});

test("there is no resume block for an empty plan", () => {
  expect(formatResume(emptyPlan())).toBe("");
});
