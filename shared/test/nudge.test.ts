import { test, expect } from "bun:test";
import { nudgeAction, createNudgeGuard } from "../nudge.ts";

test("nudgeAction never nudges without an interactive UI (one-shot guard)", () => {
  // The 72-minute hang: nudging in -p/JSON mode stalls Pi's exit.
  expect(nudgeAction("notify", false, true)).toBe("none");
  expect(nudgeAction("block", false, true)).toBe("none");
});

test("nudgeAction maps mode to action when interactive with pending work", () => {
  expect(nudgeAction("notify", true, true)).toBe("remind");
  expect(nudgeAction("block", true, true)).toBe("continue");
  expect(nudgeAction("off", true, true)).toBe("none");
  expect(nudgeAction("notify", true, false)).toBe("none"); // nothing pending
});

test("the guard allows `max` consecutive nudges against unchanged state, then stops", () => {
  const guard = createNudgeGuard();
  expect(guard.allow("a", 2)).toBe(true); // the nudge itself
  expect(guard.allow("a", 2)).toBe(true); // one retry, still no progress
  expect(guard.allow("a", 2)).toBe(false); // and that is the limit
  expect(guard.allow("a", 2)).toBe(false); // which does not lapse on its own
});

test("the guard rearms as soon as the state changes", () => {
  const guard = createNudgeGuard();
  guard.allow("a", 2);
  guard.allow("a", 2);
  expect(guard.allow("a", 2)).toBe(false);
  // Progress: a different signature means the last nudge achieved something.
  expect(guard.allow("b", 2)).toBe(true);
  expect(guard.allow("b", 2)).toBe(true);
  expect(guard.allow("b", 2)).toBe(false);
});

test("max: 1 permits a single nudge and no retry", () => {
  const guard = createNudgeGuard();
  expect(guard.allow("a", 1)).toBe(true);
  expect(guard.allow("a", 1)).toBe(false);
});

test("a raised limit takes effect on the next call, not at construction", () => {
  // `max` is a parameter precisely so a config change mid-session is honoured.
  const guard = createNudgeGuard();
  expect(guard.allow("a", 1)).toBe(true);
  expect(guard.allow("a", 1)).toBe(false);
  expect(guard.allow("a", 5)).toBe(true);
});

test("reset forgets the history", () => {
  const guard = createNudgeGuard();
  guard.allow("a", 2);
  guard.allow("a", 2);
  expect(guard.allow("a", 2)).toBe(false);
  guard.reset();
  expect(guard.allow("a", 2)).toBe(true);
});

test("an empty signature is not mistaken for the initial state", () => {
  // `lastSignature` starts as null rather than "", so a caller whose first signature is
  // blank still gets its first nudge instead of being counted as an immediate repeat.
  const guard = createNudgeGuard();
  expect(guard.allow("", 2)).toBe(true);
  expect(guard.allow("", 2)).toBe(true);
  expect(guard.allow("", 2)).toBe(false);
});
