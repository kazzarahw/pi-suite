import { test, expect } from "bun:test";
import { appendState, restoreState } from "../src/persist.ts";
import type { Goal } from "../src/state.ts";

const entry = (data: unknown) => ({ type: "custom", customType: "goal-state", data });
const goal: Goal = { objective: "ship it", criteria: "tests pass", status: "active" };

test("appendState writes one goal-state entry", () => {
  const entries: Array<{ customType: string; data?: unknown }> = [];
  appendState({ appendEntry: (customType, data) => entries.push({ customType, data }) }, goal);
  expect(entries).toEqual([{ customType: "goal-state", data: { goal } }]);
});

test("restoreState reads the most recent entry, not the first", () => {
  const restored = restoreState({
    sessionManager: {
      getBranch: () => [
        entry({ goal: { objective: "old", status: "active" } }),
        { type: "message" },
        entry({ goal }),
      ],
    },
  });
  expect(restored).toEqual(goal);
});

test("a cleared objective survives a restore", () => {
  // The newest entry wins, so `/pi-goal clear` is not undone by the entry behind it.
  const restored = restoreState({
    sessionManager: { getBranch: () => [entry({ goal }), entry({ goal: null })] },
  });
  expect(restored).toBeNull();
});

test("restoreState is null with no branch, no entry, or a malformed one", () => {
  expect(restoreState({})).toBeNull();
  expect(restoreState({ sessionManager: null })).toBeNull();
  expect(restoreState({ sessionManager: { getBranch: () => [] } })).toBeNull();
  expect(restoreState({ sessionManager: { getBranch: () => [{ type: "message" }] } })).toBeNull();
  expect(restoreState({ sessionManager: { getBranch: () => [entry({ goal: {} })] } })).toBeNull();
  expect(restoreState({ sessionManager: { getBranch: () => [entry(undefined)] } })).toBeNull();
});

test("an unrecognised status is normalised rather than reaching the agent", () => {
  // `MARKERS[status]` on an unknown value yields `undefined`, which renders as the
  // literal string "undefined" in the widget and the injected block — corrupting
  // agent-facing output instead of failing. Reachable from a hand-edited session file.
  const restored = restoreState({
    sessionManager: {
      getBranch: () => [entry({ goal: { objective: "ship it", status: "abandoned" } })],
    },
  });
  expect(restored).toEqual({ objective: "ship it", status: "active" });
});

test("a non-string criteria is dropped rather than rendered", () => {
  const restored = restoreState({
    sessionManager: {
      getBranch: () => [entry({ goal: { objective: "ship it", status: "met", criteria: 42 } })],
    },
  });
  expect(restored).toEqual({ objective: "ship it", status: "met" });
});

test("entries of another extension's custom type are ignored", () => {
  const restored = restoreState({
    sessionManager: {
      getBranch: () => [entry({ goal }), { type: "custom", customType: "todo-state", data: {} }],
    },
  });
  expect(restored).toEqual(goal);
});
