import { test, expect } from "bun:test";
import { appendState, restoreState } from "../src/persist.ts";
import { activeItem, emptyPlan, type Plan } from "../src/state.ts";

/** The branch-entry shape `restoreState` walks — Pi's session entries, as it sees them. */
interface Entry {
  type?: string;
  customType?: string;
  data?: unknown;
}

const entry = (plan: unknown): Entry => ({
  type: "custom",
  customType: "plan-state",
  data: { plan },
});
const ctxWith = (...branch: Entry[]) => ({ sessionManager: { getBranch: () => branch } });

const full: Plan = {
  objective: { objective: "merge todo and goal", criteria: "one extension", status: "active" },
  items: [
    { id: "1", content: "design the state", status: "active", approach: "read both first",
      steps: [{ content: "read them", done: true }, { content: "write it", done: false }] },
    { id: "2", content: "write the tests", status: "pending" },
  ],
  log: [{ content: "survey the repo", outcome: "done", note: "took an hour" }],
  seq: 3,
};

test("a plan round-trips through the session entry", () => {
  const appended: Array<{ customType: string; data?: unknown }> = [];
  appendState({ appendEntry: (customType, data) => appended.push({ customType, data }) }, full);
  expect(appended[0]!.customType).toBe("plan-state");
  // Restored from what `appendState` actually wrote, not from a hand-built fixture that
  // could drift from it.
  expect(restoreState(ctxWith({ type: "custom", ...appended[0]! }))).toEqual(full);
});

test("no entry, a malformed entry, or a recorded reset all restore an empty plan", () => {
  expect(restoreState(ctxWith())).toEqual(emptyPlan());
  expect(restoreState({ sessionManager: null })).toEqual(emptyPlan());
  expect(restoreState(ctxWith(entry("not an object")))).toEqual(emptyPlan());
  // The newest entry wins, so `/pi-plan reset` survives a fork rather than being undone
  // by the older entry sitting behind it.
  expect(restoreState(ctxWith(entry(full), entry(emptyPlan())))).toEqual(emptyPlan());
});

test("the newest plan-state entry wins over older ones", () => {
  const older = { ...emptyPlan(), objective: { objective: "old", status: "active" as const } };
  const newer = { ...emptyPlan(), objective: { objective: "new", status: "active" as const } };
  expect(restoreState(ctxWith(entry(older), entry(newer))).objective!.objective).toBe("new");
});

test("entries that are not plan-state are ignored", () => {
  const other = { type: "custom", customType: "goal-state", data: { goal: { objective: "x" } } };
  expect(restoreState(ctxWith(entry(full), other))).toEqual(full);
});

// ---------------------------------------------------------------------------
// The invariants, re-established. This is the one place pi-plan reads state it did not
// construct, so it is the one place they can arrive broken — a hand-edited session file,
// a fork of a session written by an older version, a truncated write.
// ---------------------------------------------------------------------------

test("only the first active item survives; the rest are demoted", () => {
  const plan = restoreState(
    ctxWith(
      entry({
        ...emptyPlan(),
        items: [
          { id: "1", content: "a", status: "active", approach: "x" },
          { id: "2", content: "b", status: "active", approach: "y" },
        ],
      }),
    ),
  );
  expect(plan.items.map((i) => i.status)).toEqual(["active", "pending"]);
  expect(activeItem(plan)!.id).toBe("1");
});

test("an active item with no approach is demoted rather than left in an impossible state", () => {
  // `applyStart` could never have produced this, and `gateEdit` would otherwise have to
  // treat it as permanently blocking. Demoting is honest; inventing an approach is not.
  const plan = restoreState(
    ctxWith(entry({ ...emptyPlan(), items: [{ id: "1", content: "a", status: "active" }] })),
  );
  expect(plan.items[0]!.status).toBe("pending");
  expect(plan.items[0]!.approach).toBeUndefined();
  expect(activeItem(plan)).toBeNull();
});

test("an unrecognised status falls back rather than reaching the marker table", () => {
  // pi-goal's lesson: an unknown status yields `MARKERS[status] === undefined` and puts
  // the literal string into the agent's context rather than failing anywhere visible.
  const plan = restoreState(
    ctxWith(
      entry({
        objective: { objective: "x", status: "bogus" },
        items: [{ id: "1", content: "a", status: "in_progress" }],
        log: [{ content: "b", outcome: "nonsense", note: "n" }],
        seq: 2,
      }),
    ),
  );
  expect(plan.objective!.status).toBe("active");
  expect(plan.items[0]!.status).toBe("pending");
  expect(plan.log[0]!.outcome).toBe("done");
});

test("seq is raised past every id in use, so a restored id is never reused", () => {
  const plan = restoreState(
    ctxWith(
      entry({
        ...emptyPlan(),
        items: [{ id: "7", content: "a", status: "pending" }],
        seq: 2, // behind reality — a truncated write, or a hand edit
      }),
    ),
  );
  expect(plan.seq).toBe(8);
});

test("a missing or nonsense seq still lands somewhere usable", () => {
  expect(restoreState(ctxWith(entry({ ...emptyPlan(), seq: undefined }))).seq).toBe(1);
  expect(restoreState(ctxWith(entry({ ...emptyPlan(), seq: "many" }))).seq).toBe(1);
  expect(restoreState(ctxWith(entry({ ...emptyPlan(), seq: 4.7 }))).seq).toBe(4);
});

test("items and log entries missing their required text are dropped, not kept blank", () => {
  const plan = restoreState(
    ctxWith(
      entry({
        objective: { objective: "   " },
        items: [
          { id: "1", content: "keep" },
          { id: "2" },
          { content: "no id" },
          "not an object",
        ],
        log: [
          { content: "kept", outcome: "dropped", note: "why" },
          { content: "no note" },
          { note: "no content" },
        ],
        seq: 3,
      }),
    ),
  );
  // A blank objective is not an objective; a log entry with no note records nothing.
  expect(plan.objective).toBeNull();
  expect(plan.items.map((i) => i.content)).toEqual(["keep"]);
  expect(plan.log).toEqual([{ content: "kept", outcome: "dropped", note: "why" }]);
});

test("malformed steps are filtered without taking the item with them", () => {
  const plan = restoreState(
    ctxWith(
      entry({
        ...emptyPlan(),
        items: [
          {
            id: "1",
            content: "a",
            status: "active",
            approach: "x",
            steps: [{ content: "real", done: true }, { done: true }, "nope"],
          },
        ],
      }),
    ),
  );
  expect(plan.items[0]!.steps).toEqual([{ content: "real", done: true }]);
  expect(plan.items[0]!.status).toBe("active");
});

test("a non-array steps field leaves the item without a worksheet", () => {
  const plan = restoreState(
    ctxWith(
      entry({ ...emptyPlan(), items: [{ id: "1", content: "a", status: "pending", steps: 5 }] }),
    ),
  );
  expect(plan.items[0]!.steps).toBeUndefined();
});

test("criteria survives when present and is dropped when blank", () => {
  const withCriteria = restoreState(
    ctxWith(entry({ ...emptyPlan(), objective: { objective: "x", criteria: "y", status: "met" } })),
  );
  expect(withCriteria.objective).toEqual({ objective: "x", criteria: "y", status: "met" });

  const without = restoreState(
    ctxWith(entry({ ...emptyPlan(), objective: { objective: "x", criteria: "  " } })),
  );
  expect(without.objective!.criteria).toBeUndefined();
});
