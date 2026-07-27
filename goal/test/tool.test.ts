import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fakeCtx } from "../../shared/test/harness.ts";
import { buildGoalTool, describeCall } from "../src/tool.ts";
import type { Goal } from "../src/state.ts";

function harness(initial: Goal | null = null) {
  let goal = initial;
  const emitted: Array<{ event: string; data: unknown }> = [];
  const persisted: Array<Goal | null> = [];
  const tool = buildGoalTool({
    getState: () => goal,
    setState: (g) => {
      goal = g;
    },
    emit: (event, data) => emitted.push({ event, data }),
    persist: (g) => persisted.push(g),
    renderContext: () => ({ turns: 0, progress: null, verify: null }),
  });
  const run = (params: unknown, ctx = fakeCtx()) =>
    tool.execute("call-1", params as never, undefined, undefined, ctx as unknown as ExtensionContext);
  return { tool, run, emitted, persisted, current: () => goal };
}

test("the tool is named and described per the suite's contract", () => {
  const { tool } = harness();
  expect(tool.name).toBe("goal");
  expect(tool.description.length).toBeGreaterThan(20);
  expect(tool.promptSnippet).toBeTruthy();
});

test("goal records the objective, persists it, and echoes it", async () => {
  const h = harness();
  const result = (await h.run({ objective: "ship the auth refactor" })) as {
    content: Array<{ text: string }>;
    details: { goal: Goal };
  };
  expect(h.current()).toEqual({ objective: "ship the auth refactor", status: "active" });
  expect(h.persisted).toEqual([{ objective: "ship the auth refactor", status: "active" }]);
  expect(result.content[0]!.text).toContain("ship the auth refactor");
  // `details` is what Pi reconstructs extension state from across a fork.
  expect(result.details.goal.objective).toBe("ship the auth refactor");
});

test("goal paints the widget", async () => {
  const h = harness();
  const ctx = fakeCtx();
  await h.run({ objective: "ship it" }, ctx);
  expect(ctx.uiCalls.widgets.filter((w) => w.id === "goal")).toHaveLength(1);
});

test("goal:set carries the objective and criteria, self-contained", async () => {
  const h = harness();
  await h.run({ objective: "ship it", criteria: "tests pass" });
  expect(h.emitted).toEqual([
    { event: "goal:set", data: { objective: "ship it", criteria: "tests pass" } },
  ]);
});

test("goal:met fires on the transition, and only once", async () => {
  const h = harness();
  await h.run({ objective: "ship it" });
  await h.run({ objective: "ship it", status: "met" });
  await h.run({ objective: "ship it", status: "met" });
  expect(h.emitted.filter((e) => e.event === "goal:met")).toEqual([
    { event: "goal:met", data: { objective: "ship it" } },
  ]);
  // Every write still reports itself, the way todo:updated does.
  expect(h.emitted.filter((e) => e.event === "goal:set")).toHaveLength(3);
});

test("a blank objective throws rather than being stored", async () => {
  // Pi sets isError only when execute throws, and a blank north-star is worse than none.
  const h = harness();
  await expect(h.run({ objective: "   " })).rejects.toThrow("[pi-goal]");
  expect(h.current()).toBeNull();
  expect(h.persisted).toEqual([]);
});

test("whitespace around the objective and criteria is trimmed", async () => {
  const h = harness();
  await h.run({ objective: "  ship it  ", criteria: "  tests pass  " });
  expect(h.current()).toEqual({ objective: "ship it", criteria: "tests pass", status: "active" });
});

test("blank criteria are dropped rather than stored as an empty line", async () => {
  const h = harness();
  await h.run({ objective: "ship it", criteria: "   " });
  expect(h.current()).toEqual({ objective: "ship it", status: "active" });
});

test("the tool works without a UI", async () => {
  const h = harness();
  const ctx = fakeCtx({ hasUI: false });
  await expect(h.run({ objective: "ship it" }, ctx)).resolves.toBeDefined();
});

// The row a user watching actually reads. Pure, so it needs no terminal.
test("describeCall shows the objective, and marks the call that closes it", () => {
  expect(describeCall({ objective: "ship the release" } as never)).toBe("ship the release");
  expect(describeCall({ objective: "  padded  " } as never)).toBe("padded");
  expect(describeCall({ objective: "ship it", status: "met" } as never)).toBe("ship it (met)");
  // A blank objective is refused by execute; the row must not invent a target for it.
  expect(describeCall({ objective: "   " } as never)).toBe("");
});
