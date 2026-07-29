import { test, expect } from "bun:test";
import {
  activeItem,
  applyAdd,
  applyClear,
  applyDrop,
  applyFinish,
  applyItems,
  applyObjective,
  applyPromote,
  applyStart,
  applyStep,
  emptyPlan,
  type Plan,
} from "../src/state.ts";

/** A plan with `contents` as pending items, ids assigned in order from 1. */
const withItems = (...contents: string[]): Plan =>
  applyItems(emptyPlan(), contents.map((content) => ({ content }))).plan;

/** The same, with the first item started. */
const started = (approach = "read both extensions first", ...contents: string[]): Plan =>
  applyStart(withItems(...contents), "1", approach).plan;

// ---------------------------------------------------------------------------
// `add` — the additive path, which exists because full-replace priced revision out of
// reach. Everything it does *not* do is the point: no removal, no reorder, no rewrite.
// ---------------------------------------------------------------------------

test("add appends without disturbing what is already open", () => {
  const plan = applyAdd(withItems("a", "b"), [{ content: "c" }]).plan;
  expect(plan.items.map((i) => i.content)).toEqual(["a", "b", "c"]);
  expect(plan.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
});

test("add cannot touch the active item, so the invariant items must check is unreachable", () => {
  const plan = applyAdd(started("read both first", "a", "b"), [{ content: "c" }]).plan;
  const active = activeItem(plan)!;
  expect(active.content).toBe("a");
  expect(active.approach).toBe("read both first");
  // `applyItems` throws here when the active item is omitted; `add` has no way to omit it.
  expect(plan.items).toHaveLength(3);
});

test("add draws fresh ids from seq, so a resolved id is never reissued", () => {
  const resolved = applyFinish(started("x", "a", "b"), "did it").plan;
  expect(applyAdd(resolved, [{ content: "c" }]).plan.items.map((i) => i.id)).toEqual(["2", "3"]);
});

test("add refuses to duplicate an open item", () => {
  // A second copy is a small lie about how much work is left.
  expect(() => applyAdd(withItems("a", "b"), [{ content: "a" }])).toThrow(/already open as id 1/);
});

test("adding what was already resolved is allowed — it is new work, not a duplicate", () => {
  // The log is history; re-opening something is a legitimate thing to learn.
  const resolved = applyFinish(started("x", "a"), "did it").plan;
  expect(applyAdd(resolved, [{ content: "a" }]).plan.items.map((i) => i.content)).toEqual(["a"]);
});

test("add refuses an empty list rather than silently doing nothing", () => {
  expect(() => applyAdd(withItems("a"), [])).toThrow(/at least one item/);
});

test("add returns what it added, for the caller that needs to name it", () => {
  const { added } = applyAdd(withItems("a"), [{ content: "b" }, { content: "c" }]);
  expect(added.map((i) => i.id)).toEqual(["2", "3"]);
  expect(added.every((i) => i.status === "pending")).toBe(true);
});

// ---------------------------------------------------------------------------
// The objective. Ported from pi-goal's state tests — the carry-forward rules were
// already right, and the merge must not quietly relax them.
// ---------------------------------------------------------------------------

test("a new objective defaults to active", () => {
  const { plan, newlyMet } = applyObjective(emptyPlan(), { objective: "ship the refactor" });
  expect(plan.objective).toEqual({ objective: "ship the refactor", status: "active" });
  expect(newlyMet).toBe(false);
});

test("restating the same objective carries omitted criteria forward", () => {
  const first = applyObjective(emptyPlan(), {
    objective: "ship it",
    criteria: "tokens rotate cleanly",
  }).plan;
  const second = applyObjective(first, { objective: "ship it", status: "met" }).plan;
  expect(second.objective!.criteria).toBe("tokens rotate cleanly");
});

test("restating the same objective carries omitted status forward, so it cannot silently reopen", () => {
  // The asymmetry this pins was a live regression: `criteria` carried and `status` did
  // not, so amending the criteria of a met objective quietly reset it to active.
  const met = applyObjective(emptyPlan(), { objective: "ship it", status: "met" }).plan;
  const amended = applyObjective(met, { objective: "ship it", criteria: "tests pass" }).plan;
  expect(amended.objective!.status).toBe("met");
});

test("reopening a met objective is possible, but has to be said", () => {
  const met = applyObjective(emptyPlan(), { objective: "ship it", status: "met" }).plan;
  const reopened = applyObjective(met, { objective: "ship it", status: "active" }).plan;
  expect(reopened.objective!.status).toBe("active");
});

test("a different objective starts fresh rather than inheriting", () => {
  const first = applyObjective(emptyPlan(), {
    objective: "first",
    criteria: "c",
    status: "met",
  }).plan;
  const second = applyObjective(first, { objective: "second" }).plan;
  expect(second.objective).toEqual({ objective: "second", status: "active" });
});

test("newlyMet is idempotent, so a repeated call cannot emit plan:met twice", () => {
  const met = applyObjective(emptyPlan(), { objective: "ship it", status: "met" });
  expect(met.newlyMet).toBe(true);
  expect(applyObjective(met.plan, { objective: "ship it", status: "met" }).newlyMet).toBe(false);
  // And a bare restatement of a met objective reports nothing either.
  expect(applyObjective(met.plan, { objective: "ship it" }).newlyMet).toBe(false);
});

// ---------------------------------------------------------------------------
// The open list.
// ---------------------------------------------------------------------------

test("ids are ordinals drawn from seq, in order", () => {
  const plan = withItems("a", "b", "c");
  expect(plan.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
  expect(plan.seq).toBe(4);
});

test("an item resent by content keeps its id", () => {
  const first = withItems("a", "b");
  const second = applyItems(first, [{ content: "b" }, { content: "a" }]).plan;
  expect(second.items.map((i) => `${i.id}:${i.content}`)).toEqual(["2:b", "1:a"]);
});

test("an item resent by explicit id keeps it even when the content changed", () => {
  const first = withItems("design the state shape");
  const second = applyItems(first, [{ id: "1", content: "design the state shape (revised)" }]).plan;
  expect(second.items[0]).toMatchObject({ id: "1", content: "design the state shape (revised)" });
});

test("a rewrite carries the active item's status and approach across", () => {
  // This is what makes full-replace safe for in-flight work: the agent sends `{ content }`
  // and gets its own approach back rather than a reset item.
  const plan = started("read both first", "a", "b");
  const rewritten = applyItems(plan, [{ content: "a" }, { content: "b" }, { content: "c" }]).plan;
  const active = activeItem(rewritten)!;
  expect(active.status).toBe("active");
  expect(active.approach).toBe("read both first");
  expect(rewritten.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
});

test("a rewrite preserves a ticked worksheet", () => {
  const plan = applyStart(withItems("a"), "1", "an approach", ["step one", "step two"]).plan;
  const ticked = applyStep(plan, { index: 0, done: true }).plan;
  const rewritten = applyItems(ticked, [{ content: "a" }]).plan;
  expect(activeItem(rewritten)!.steps).toEqual([
    { content: "step one", done: true },
    { content: "step two", done: false },
  ]);
});

// THE invariant that makes the list a workflow rather than a wishlist. Dropping active
// work by leaving it out of a rewrite is the silent failure the extension exists to stop.
test("a rewrite that omits the active item is refused", () => {
  const plan = started("an approach", "a", "b");
  expect(() => applyItems(plan, [{ content: "b" }])).toThrow(/active item/);
  expect(() => applyItems(plan, [])).toThrow(/finish|drop/);
});

test("a rewrite may omit any PENDING item — that is what replace means", () => {
  const plan = withItems("a", "b", "c");
  expect(applyItems(plan, [{ content: "b" }]).plan.items.map((i) => i.content)).toEqual(["b"]);
});

test("seq never reuses an id, even after everything is resolved", () => {
  const plan = applyFinish(applyStart(withItems("a"), "1", "x").plan, "did it").plan;
  expect(plan.items).toEqual([]);
  const next = applyItems(plan, [{ content: "something new" }]).plan;
  expect(next.items[0]!.id).toBe("2");
});

// ---------------------------------------------------------------------------
// The lifecycle.
// ---------------------------------------------------------------------------

test("starting requires an approach", () => {
  expect(() => applyStart(withItems("a"), "1", "   ")).toThrow(/approach/);
});

test("starting an unknown id is refused, and the refusal names what would have worked", () => {
  // A refusal that does not name the way out is the failure this extension complains
  // about everywhere else. Dogfooding watched an agent burn two turns on this one and
  // then abandon the plan mid-session.
  expect(() => applyStart(withItems("a"), "99", "x")).toThrow(/no open item matches "99"/);
  expect(() => applyStart(withItems("a", "b"), "99", "x")).toThrow(/1 \("a"\), 2 \("b"\)/);
});

test("an empty list says so rather than listing nothing", () => {
  expect(() => applyStart(emptyPlan(), "1", "x")).toThrow(/nothing is open/);
});

// ---------------------------------------------------------------------------
// Content is a way of naming an item, because `applyItems` already says so — it carries
// id, status, approach, and worksheet across a rewrite by matching on content. `start`
// and `drop` taking only the ordinal made them the two verbs that disagreed.
// ---------------------------------------------------------------------------

test("start accepts the item's content, not only its id", () => {
  const plan = applyStart(withItems("write the tests", "b"), "write the tests", "read first").plan;
  const active = activeItem(plan)!;
  expect(active.id).toBe("1");
  expect(active.approach).toBe("read first");
});

test("drop accepts the item's content too", () => {
  const { plan, entry } = applyDrop(withItems("a", "unnecessary work"), "unnecessary work", "moot");
  expect(entry.content).toBe("unnecessary work");
  expect(plan.items.map((i) => i.content)).toEqual(["a"]);
});

test("an id wins over content that happens to collide with it", () => {
  // An item literally called "1" must not shadow the item whose id is 1.
  const plan = applyItems(emptyPlan(), [{ content: "first" }, { content: "1" }]).plan;
  expect(activeItem(applyStart(plan, "1", "x").plan)!.content).toBe("first");
});

// THE constraint the whole extension is built on.
test("only one item can be active at a time", () => {
  const plan = started("an approach", "a", "b");
  expect(() => applyStart(plan, "2", "another approach")).toThrow(/already active/);
});

test("an active item always carries its approach", () => {
  const plan = applyStart(withItems("a"), "1", "  read both extensions  ").plan;
  const active = activeItem(plan)!;
  expect(active.status).toBe("active");
  expect(active.approach).toBe("read both extensions"); // trimmed
});

test("steps tick, untick, and append", () => {
  let plan = applyStart(withItems("a"), "1", "x", ["one", "two"]).plan;
  plan = applyStep(plan, { index: 1, done: true }).plan;
  expect(activeItem(plan)!.steps).toEqual([
    { content: "one", done: false },
    { content: "two", done: true },
  ]);
  plan = applyStep(plan, { index: 1, done: false }).plan;
  expect(activeItem(plan)!.steps![1]!.done).toBe(false);
  plan = applyStep(plan, { steps: ["three"] }).plan;
  expect(activeItem(plan)!.steps!.map((s) => s.content)).toEqual(["one", "two", "three"]);
});

test("a worksheet edit with nothing active is refused", () => {
  expect(() => applyStep(withItems("a"), { steps: ["x"] })).toThrow(/nothing is active/);
});

test("a worksheet edit out of range is refused rather than silently ignored", () => {
  const plan = applyStart(withItems("a"), "1", "x", ["one"]).plan;
  expect(() => applyStep(plan, { index: 5, done: true })).toThrow(/no step at index 5/);
});

test("promoting a step removes it from the worksheet and lands it after the active item", () => {
  const plan = applyStart(withItems("a", "z"), "1", "x", ["keep", "promote me"]).plan;
  const { plan: after, item } = applyPromote(plan, 1);
  expect(activeItem(after)!.steps!.map((s) => s.content)).toEqual(["keep"]);
  // Directly after the active one, not appended to the end — it is the work that was
  // discovered inside this item, so it belongs next to it.
  expect(after.items.map((i) => i.content)).toEqual(["a", "promote me", "z"]);
  expect(item.status).toBe("pending");
  expect(after.items.map((i) => i.id)).toEqual(["1", "3", "2"]);
});

test("promoting from nothing, or out of range, is refused", () => {
  expect(() => applyPromote(withItems("a"), 0)).toThrow(/nothing is active/);
  const plan = applyStart(withItems("a"), "1", "x", ["one"]).plan;
  expect(() => applyPromote(plan, 4)).toThrow(/no step at index 4/);
});

// ---------------------------------------------------------------------------
// Resolution, and the log.
// ---------------------------------------------------------------------------

test("finishing moves the item to the log and discards the worksheet", () => {
  const plan = applyStart(withItems("a"), "1", "x", ["scaffolding", "more scaffolding"]).plan;
  const { plan: after, entry } = applyFinish(plan, "landed in a single commit");
  expect(after.items).toEqual([]);
  expect(entry).toEqual({ content: "a", outcome: "done", note: "landed in a single commit" });
  expect(after.log).toEqual([entry]);
  // The worksheet goes with the item — nobody cares about its steps afterwards, and the
  // note is what survives in its place.
  expect(JSON.stringify(after)).not.toContain("scaffolding");
});

test("finishing costs a note, and there must be something active to finish", () => {
  const plan = applyStart(withItems("a"), "1", "x").plan;
  expect(() => applyFinish(plan, "  ")).toThrow(/requires a note/);
  expect(() => applyFinish(withItems("a"), "done")).toThrow(/nothing is active/);
});

test("dropping costs a reason and records it, for an active or a pending item", () => {
  const active = applyStart(withItems("a", "b"), "1", "x").plan;
  expect(() => applyDrop(active, "1", " ")).toThrow(/requires a reason/);
  expect(() => applyDrop(active, "99", "r")).toThrow(/no open item matches "99"/);

  const droppedActive = applyDrop(active, "1", "turned out to be unnecessary");
  expect(droppedActive.entry.outcome).toBe("dropped");
  expect(activeItem(droppedActive.plan)).toBeNull();

  const droppedPending = applyDrop(active, "2", "superseded").plan;
  expect(droppedPending.items.map((i) => i.id)).toEqual(["1"]);
  expect(droppedPending.log[0]!.note).toBe("superseded");
});

// THE property that makes the log a record rather than a scratch pad: you may revise the
// future, never the past.
test("the log is append-only and unreachable from the replace op", () => {
  const resolved = applyFinish(applyStart(withItems("a"), "1", "x").plan, "did it").plan;
  expect(resolved.log).toHaveLength(1);

  // Re-sending the resolved item's content creates a NEW open item; it does not reach
  // back into the log, and it does not resurrect the old one's id.
  const rewritten = applyItems(resolved, [{ content: "a" }]).plan;
  expect(rewritten.log).toEqual(resolved.log);
  expect(rewritten.items[0]!.id).toBe("2");

  // And every later write leaves the earlier entries exactly as they were.
  const more = applyDrop(rewritten, "2", "changed my mind").plan;
  expect(more.log[0]).toEqual(resolved.log[0]!);
  expect(more.log).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// The user's overrides.
// ---------------------------------------------------------------------------

test("clear forgets the objective and the open list but keeps the log and seq", () => {
  const resolved = applyDrop(withItems("a", "b"), "1", "not needed").plan;
  const planned = applyObjective(resolved, { objective: "ship it" }).plan;

  const cleared = applyClear(planned).plan;
  expect(cleared.objective).toBeNull();
  expect(cleared.items).toEqual([]);
  // The point of keeping it: the agent must not be free to re-propose what it just dropped.
  expect(cleared.log).toEqual(planned.log);
  // And an id already referenced by a log entry can never be handed out again.
  expect(cleared.seq).toBe(planned.seq);
  expect(applyItems(cleared, [{ content: "fresh" }]).plan.items[0]!.id).toBe("3");
});

test("clear disarms the gate, which is what makes it an escape hatch", () => {
  // `gateEdit` arms on an objective or an open item; clear leaves neither. Asserted here
  // as a property of the reducer so gate.test.ts does not have to reconstruct the state.
  const cleared = applyClear(applyObjective(withItems("a"), { objective: "x" }).plan).plan;
  expect(cleared.objective).toBeNull();
  expect(cleared.items).toEqual([]);
});
