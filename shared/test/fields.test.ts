import { test, expect } from "bun:test";
import { bool, int, nonEmptyStr, oneOf, optionalStr, posNum, str, strList } from "../fields.ts";

/**
 * The validators behind every `ConfigSpec.parse`.
 *
 * These replaced ~25 inline copies that had drifted apart; the drift is the reason each
 * boundary below is pinned rather than assumed. Everything here is pure — no filesystem,
 * no env — so a case is one line.
 */

test("str keeps any string, including the empty one", () => {
  // "" is meaningful: pi-lens uses it for "autodetect the verify command".
  expect(str("", "fallback")).toBe("");
  expect(str("x", "fallback")).toBe("x");
});

test("str falls back for every non-string", () => {
  for (const bad of [undefined, null, 0, 1, true, [], {}]) {
    expect(str(bad, "fallback")).toBe("fallback");
  }
});

test("nonEmptyStr rejects the empty string, unlike str", () => {
  expect(nonEmptyStr("", "agent-browser")).toBe("agent-browser");
  expect(nonEmptyStr("custom", "agent-browser")).toBe("custom");
  expect(nonEmptyStr(42, "agent-browser")).toBe("agent-browser");
});

test("optionalStr yields undefined for absent, blank, and wrong-typed values", () => {
  expect(optionalStr("named")).toBe("named");
  expect(optionalStr("")).toBeUndefined();
  expect(optionalStr(undefined)).toBeUndefined();
  expect(optionalStr(7)).toBeUndefined();
});

test("bool accepts only real booleans — not truthy strings", () => {
  expect(bool(true, false)).toBe(true);
  expect(bool(false, true)).toBe(false);
  // A hand-edited `"detectDirty": "yes"` must not read as true.
  expect(bool("yes", false)).toBe(false);
  expect(bool(1, false)).toBe(false);
  expect(bool(undefined, true)).toBe(true);
});

test("posNum accepts finite positives and rejects zero, negatives, and NaN", () => {
  expect(posNum(1, 9)).toBe(1);
  expect(posNum(0.5, 9)).toBe(0.5);
  expect(posNum(0, 9)).toBe(9);
  expect(posNum(-1, 9)).toBe(9);
  expect(posNum(Number.NaN, 9)).toBe(9);
  expect(posNum("5", 9)).toBe(9);
});

test("posNum rejects Infinity — the case the inline copies got wrong", () => {
  // `Infinity > 0` is true, so every `value > 0` guard let this through. A timeout of
  // Infinity is not a long timeout; it is no timeout at all.
  expect(posNum(Number.POSITIVE_INFINITY, 9)).toBe(9);
  expect(posNum(Number.NEGATIVE_INFINITY, 9)).toBe(9);
});

test("int floors toward zero and enforces the minimum", () => {
  expect(int(3.9, 4)).toBe(3);
  expect(int(1, 4)).toBe(1);
  expect(int(0, 4)).toBe(4); // below the default min of 1
  expect(int(-2, 4)).toBe(4);
  expect(int(0, 4, 0)).toBe(0); // explicit min lets zero through
});

test("int rejects non-finite values rather than flooring them", () => {
  expect(int(Number.POSITIVE_INFINITY, 4)).toBe(4);
  expect(int(Number.NaN, 4)).toBe(4);
  expect(int("3", 4)).toBe(4);
});

test("oneOf admits only declared members", () => {
  const MODES = ["off", "notify", "block"] as const;
  expect(oneOf("block", MODES, "notify")).toBe("block");
  expect(oneOf("nope", MODES, "notify")).toBe("notify");
  expect(oneOf(undefined, MODES, "notify")).toBe("notify");
  expect(oneOf(0, MODES, "notify")).toBe("notify");
});

test("strList keeps the string elements and drops the rest", () => {
  expect(strList(["a", 1, "b", null], ["z"])).toEqual(["a", "b"]);
  // An array of nothing usable is still an array — the fallback is for non-arrays only,
  // so a deliberate `[]` is honored rather than silently repopulated.
  expect(strList([], ["z"])).toEqual([]);
  expect(strList("a,b", ["z"])).toEqual(["z"]);
  expect(strList(undefined, ["z"])).toEqual(["z"]);
});
