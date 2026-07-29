import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildPlanTool, describeCall } from "../src/tool.ts";
import { emptyPlan, type Plan } from "../src/state.ts";
import { fakeCtx, type FakeCtx } from "../../shared/test/harness.ts";
import type { EventName, EventPayloads } from "../../shared/index.ts";

/** A tool bound to in-memory state, so a test can drive a whole session of calls. */
function harness(initial: Plan = emptyPlan()) {
  let plan = initial;
  const emitted: Array<{ event: string; data: unknown }> = [];
  const persisted: Plan[] = [];
  const tool = buildPlanTool({
    getState: () => plan,
    setState: (p) => {
      plan = p;
    },
    emit: <E extends EventName>(event: E, data: EventPayloads[E]) => {
      emitted.push({ event, data });
    },
    persist: (p) => persisted.push(p),
    renderContext: () => null,
  });
  const call = (params: Record<string, unknown>, ctx: FakeCtx = fakeCtx()) =>
    tool.execute("c1", params as never, undefined, undefined, ctx as unknown as ExtensionContext);
  return { call, emitted, persisted, plan: () => plan, tool };
}

// ---------------------------------------------------------------------------
// The per-action required-field check.
//
// This is what the one-tool-per-extension surface costs: the actions need disjoint
// fields, so every one is optional in the schema and the provider can no longer reject a
// malformed call on our behalf.
// ---------------------------------------------------------------------------

test("every missing field is named at once, not one round-trip at a time", async () => {
  const { call } = harness();
  // The whole point of the shape copied from memory/src/tools.ts: two missing fields cost
  // one error, not two turns.
  await expect(call({ action: "start" })).rejects.toThrow(/requires id, approach/);
  await expect(call({ action: "drop", id: "1" })).rejects.toThrow(/requires reason/);
  await expect(call({ action: "finish" })).rejects.toThrow(/requires note/);
  await expect(call({ action: "objective" })).rejects.toThrow(/requires objective/);
  await expect(call({ action: "items" })).rejects.toThrow(/requires items/);
  await expect(call({ action: "promote" })).rejects.toThrow(/requires index/);
});

test("every error is prefixed so a user can tell who refused", async () => {
  const { call } = harness();
  await expect(call({ action: "finish" })).rejects.toThrow(/^\[pi-plan\]/);
});

test("step is disjunctive, so it is checked as an either/or rather than a field list", async () => {
  const { call } = harness();
  await expect(call({ action: "step" })).rejects.toThrow(/either index and done .* or steps/);
  // A half-supplied tick is not a tick.
  await expect(call({ action: "step", index: 0 })).rejects.toThrow(/either index and done/);
  await expect(call({ action: "step", done: true })).rejects.toThrow(/either index and done/);
  await expect(call({ action: "step", steps: [] })).rejects.toThrow(/either index and done/);
});

test("a blank objective is refused rather than stored as the session's north star", async () => {
  const { call } = harness();
  await expect(call({ action: "objective", objective: "   " })).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// State, persistence, and the events.
// ---------------------------------------------------------------------------

test("a full lifecycle moves the state and persists after every call", async () => {
  const h = harness();
  await h.call({ action: "objective", objective: "merge todo and goal" });
  await h.call({ action: "items", items: [{ content: "design the state" }, { content: "test it" }] });
  await h.call({ action: "start", id: "1", approach: "read both first", steps: ["read", "write"] });
  await h.call({ action: "step", index: 0, done: true });
  await h.call({ action: "finish", note: "landed cleanly" });
  await h.call({ action: "drop", id: "2", reason: "covered by the first" });

  expect(h.plan().items).toEqual([]);
  expect(h.plan().log.map((e) => e.outcome)).toEqual(["done", "dropped"]);
  expect(h.persisted).toHaveLength(6);
});

test("each action emits what shared/events.ts declares for it", async () => {
  const h = harness();
  await h.call({ action: "objective", objective: "ship it", criteria: "tests pass" });
  expect(h.emitted).toEqual([
    { event: "plan:objective", data: { objective: "ship it", criteria: "tests pass" } },
  ]);

  await h.call({ action: "items", items: [{ content: "a" }] });
  expect(h.emitted.at(-1)!.event).toBe("plan:updated");

  await h.call({ action: "start", id: "1", approach: "x" });
  await h.call({ action: "finish", note: "did it" });
  expect(h.emitted.map((e) => e.event)).toContain("plan:item-done");
  expect(h.emitted.find((e) => e.event === "plan:item-done")!.data).toEqual({
    content: "a",
    note: "did it",
  });
});

test("plan:met is emitted once, on the transition", async () => {
  const h = harness();
  await h.call({ action: "objective", objective: "ship it" });
  await h.call({ action: "objective", objective: "ship it", status: "met" });
  await h.call({ action: "objective", objective: "ship it", status: "met" });
  expect(h.emitted.filter((e) => e.event === "plan:met")).toHaveLength(1);
});

test("plan:item-dropped carries the reason under its own key", async () => {
  const h = harness();
  await h.call({ action: "items", items: [{ content: "a" }] });
  await h.call({ action: "drop", id: "1", reason: "unnecessary" });
  expect(h.emitted.find((e) => e.event === "plan:item-dropped")!.data).toEqual({
    content: "a",
    reason: "unnecessary",
  });
});

test("promote appends the new item and reports the updated list", async () => {
  const h = harness();
  await h.call({ action: "items", items: [{ content: "a" }] });
  await h.call({ action: "start", id: "1", approach: "x", steps: ["turned out to be big"] });
  await h.call({ action: "promote", index: 0 });
  expect(h.plan().items.map((i) => i.content)).toEqual(["a", "turned out to be big"]);
});

test("appending steps goes through the same action as ticking them", async () => {
  const h = harness();
  await h.call({ action: "items", items: [{ content: "a" }] });
  await h.call({ action: "start", id: "1", approach: "x" });
  await h.call({ action: "step", steps: ["discovered later"] });
  expect(h.plan().items[0]!.steps).toEqual([{ content: "discovered later", done: false }]);
});

// ---------------------------------------------------------------------------
// The result and the widget.
// ---------------------------------------------------------------------------

test("the result echoes the plan as plain text and hands back the state in details", async () => {
  const h = harness();
  const result = await h.call({ action: "objective", objective: "merge todo and goal" });
  const text = (result.content[0] as { text: string }).text;
  // Pi's default renderResult prints this verbatim — it renders no markdown — so a `##` or
  // a `<pi-plan>` tag would reach the user's transcript as literal characters.
  expect(text).toContain("▸ merge todo and goal");
  expect(text).not.toContain("<pi-plan>");
  expect(text).not.toContain("#");
  expect(result.details.plan.objective!.objective).toBe("merge todo and goal");
});

test("the tool paints the widget on every call", async () => {
  const h = harness();
  const ctx = fakeCtx();
  await h.call({ action: "objective", objective: "ship it" }, ctx);
  expect(ctx.uiCalls.widgets.some((w) => w.id === "plan")).toBe(true);
});

test("clearing the list to nothing reports it rather than rendering blank", async () => {
  const h = harness();
  const result = await h.call({ action: "items", items: [] });
  expect((result.content[0] as { text: string }).text).toBe("(plan is empty)");
});

// ---------------------------------------------------------------------------
// The tool-call row.
// ---------------------------------------------------------------------------

test("describeCall says the interesting half of each action in one line", () => {
  expect(describeCall({ action: "objective", objective: "ship it" } as never)).toBe("ship it");
  expect(describeCall({ action: "objective", objective: "ship it", status: "met" } as never)).toBe(
    "ship it (met)",
  );
  expect(describeCall({ action: "items", items: [{ content: "a" }] } as never)).toBe("1 item");
  expect(describeCall({ action: "items", items: [] } as never)).toBe("clear the list");
  expect(describeCall({ action: "start", id: "2" } as never)).toBe("start 2");
  expect(describeCall({ action: "step", index: 1, done: true } as never)).toBe("step 1");
  expect(describeCall({ action: "step", steps: ["a", "b"] } as never)).toBe("+2 steps");
  expect(describeCall({ action: "promote", index: 0 } as never)).toBe("promote step 0");
  expect(describeCall({ action: "finish" } as never)).toBe("finish");
  expect(describeCall({ action: "drop", id: "3" } as never)).toBe("drop 3");
});

// ---------------------------------------------------------------------------
// The description is a behavioral surface, not documentation.
//
// Dogfooding on a mid-sized model found the tool ignored entirely on a genuine
// multi-step debugging session: the description explained all seven actions and never
// said *when* to reach for one. It also found `finish` called on an item that turned out
// to need no work — recording as done something that never happened, which is the exact
// lie `drop` exists to prevent, and a falsehood that outlives compaction because the log
// is what gets replayed.
//
// Both fixes live in strings, so they are pinned as strings. A future edit that tightens
// the prose is free to reword these; one that drops the trigger or the finish/drop
// distinction should have to notice it is doing so.
// ---------------------------------------------------------------------------

test("the description says when to reach for the tool, not just how to drive it", () => {
  const { tool } = harness();
  // A threshold concrete enough to evaluate against a task, and the negative case, so
  // adopting it is not the answer to every prompt.
  expect(tool.description).toContain("three or more distinct steps");
  expect(tool.description.toLowerCase()).toContain("skip it for");
  // Before, because deciding the approach afterwards is not the same thing.
  expect(tool.description).toContain("BEFORE you start working");
  // The trigger has to survive into the system prompt too — the description is only read
  // once the model is already considering the tool.
  expect(tool.promptSnippet).toContain("three or more steps");
});

test("the description tells the agent the list is revisable", () => {
  const { tool } = harness();
  expect(tool.description).toContain("revised as you learn");
});

test("finish demands evidence, and routes the no-work case to drop", () => {
  const { tool } = harness();
  const props = (tool.parameters as { properties?: Record<string, { description?: string }> })
    .properties!;
  expect(props.note!.description).toContain("what you actually changed");
  expect(props.note!.description).toContain("use 'drop' instead");
  // …and the other side of the same decision names the case that was getting finished.
  expect(props.reason!.description).toContain("already done");
  expect(tool.description).toContain("dropped, never finished");
});

test("the tool declares the surface the contract test checks for", () => {
  const { tool } = harness();
  expect(tool.name).toBe("plan");
  expect(tool.description.length).toBeGreaterThan(20);
  expect(tool.promptSnippet).toBeTruthy();
  const action = (tool.parameters as { properties?: Record<string, { enum?: string[] }> }).properties
    ?.action;
  expect(action?.enum).toEqual([
    "objective",
    "items",
    "start",
    "step",
    "promote",
    "finish",
    "drop",
  ]);
});
