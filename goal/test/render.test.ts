import { test, expect } from "bun:test";
import { renderGoal, formatInjection } from "../src/render.ts";
import type { Goal } from "../src/state.ts";

const active: Goal = { objective: "ship the auth refactor", status: "active" };
const bare = { turns: 0, progress: null, verify: null };

test("the widget marks active and met differently", () => {
  expect(renderGoal(active, bare)[0]).toBe("▸ ship the auth refactor");
  expect(renderGoal({ ...active, status: "met" }, bare)[0]).toBe("✓ ship the auth refactor");
});

test("the widget says nothing extra when there is nothing extra to say", () => {
  expect(renderGoal(active, bare)).toHaveLength(1);
});

test("the widget annotates turns and todo progress", () => {
  const lines = renderGoal(active, { turns: 4, progress: { done: 2, total: 5 }, verify: null });
  expect(lines[1]).toBe("  4 turns · 2 of 5 todos done");
});

test("one turn is singular", () => {
  expect(renderGoal(active, { turns: 1, progress: null, verify: null })[1]).toBe("  1 turn");
});

test("zero turns is omitted rather than shown", () => {
  // Zero is also what a restore reports, since the counter is in memory — printing
  // "0 turns" would claim the objective is new when it may be anything but.
  expect(renderGoal(active, { turns: 0, progress: { done: 0, total: 2 }, verify: null })[1]).toBe(
    "  0 of 2 todos done",
  );
});

test("the widget truncates a long objective rather than wrapping the terminal", () => {
  const long = "x".repeat(200);
  const line = renderGoal({ objective: long, status: "active" }, bare)[0]!;
  expect(line.length).toBeLessThanOrEqual(90);
  expect(line.endsWith("…")).toBe(true);
});

test("the injection is a tagged block with a source · why header", () => {
  const block = formatInjection(active);
  expect(block.startsWith("<pi-goal>\ngoal · current objective\n")).toBe(true);
  expect(block.endsWith("</pi-goal>")).toBe(true);
  expect(block).toContain("▸ ship the auth refactor");
});

test("the injection carries the criteria, which the widget does not", () => {
  const goal: Goal = { ...active, criteria: "sessions survive a token rotation" };
  expect(formatInjection(goal)).toContain("met when: sessions survive a token rotation");
  expect(renderGoal(goal, bare).join("\n")).not.toContain("met when");
});

// THE prompt-cache guard. The block is prepended to every LLM call, so it sits at
// message index 0, while the provider's conversation-history cache breakpoint goes on
// the LAST user message — a hit needs the whole prefix to match. Anything in here that
// ticks over per turn invalidates the entire conversation cache on every call, in
// exactly the long sessions this extension exists for. It takes no Context at all, so
// the volatile state is not merely unused here, it is unreachable.
test("the injection does not change as turns pass or todos move", () => {
  const first = formatInjection(active);
  expect(formatInjection(active)).toBe(first);
  // The same objective, after a hundred turns and a completed todo list, is byte-identical.
  expect(formatInjection({ ...active })).toBe(first);
  expect(first).not.toContain("turn");
  expect(first).not.toContain("todos");
});

test("the widget carries the volatile state the injection refuses", () => {
  const lines = renderGoal(active, { turns: 3, progress: { done: 1, total: 2 }, verify: null });
  expect(lines[1]).toBe("  3 turns · 1 of 2 todos done");
});

test("there is no injection without an objective", () => {
  expect(formatInjection(null)).toBe("");
});

test("a met objective stops being injected", () => {
  // It is finished; repeating it on every call for the rest of the session costs
  // context and buys nothing. The widget keeps the ✓.
  expect(formatInjection({ ...active, status: "met" })).toBe("");
  expect(renderGoal({ ...active, status: "met" }, bare)).toHaveLength(1);
});

test("the injection does not truncate the objective the widget clips", () => {
  // The clip is a terminal-width concern. The agent gets the whole sentence.
  const long = "x".repeat(200);
  expect(formatInjection({ objective: long, status: "active" })).toContain(long);
});
