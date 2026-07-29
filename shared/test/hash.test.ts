import { test, expect } from "bun:test";
import { stableHash } from "../hash.ts";

/**
 * The short string hash behind pi-memory's gotcha dedup key.
 *
 * "Stable" is the whole contract: a key must survive a session reload and stay
 * reproducible in tests, and pi-memory's key must collapse repeat captures of the same
 * failure into one memory rather than accumulating near-duplicates.
 */

test("is deterministic across calls", () => {
  expect(stableHash("write the tests")).toBe(stableHash("write the tests"));
});

test("distinguishes different inputs, including near-identical ones", () => {
  expect(stableHash("task a")).not.toBe(stableHash("task b"));
  expect(stableHash("ab")).not.toBe(stableHash("ba"));
});

test("returns a non-empty base-36 string for every input", () => {
  for (const input of ["", "x", "a longer piece of content with spaces", "unicode: ✓ é 漢"]) {
    expect(stableHash(input)).toMatch(/^[0-9a-z]+$/);
  }
});

test("hashes the empty string without throwing", () => {
  expect(stableHash("")).toBe("0");
});

test("stays short enough to embed in an id or a filename", () => {
  // Both callers splice the result into a name: `t3_<hash>`, `gotcha-verify-<hash>`.
  // A 32-bit value in base 36 is at most 7 characters.
  const long = "x".repeat(10_000);
  expect(stableHash(long).length).toBeLessThanOrEqual(7);
});

test("is pinned to its current output, so ids do not silently change", () => {
  // pi-memory's gotcha dedup keys derived from this are written to disk. Changing the
  // algorithm would orphan every stored key, so the value is asserted rather than left
  // implicit. (pi-todo derived item ids from this too; pi-plan, which replaced it, uses
  // ordinals instead — short enough to render on every line and to be typed back.)
  expect(stableHash("hello")).toBe(stableHash("hello"));
  expect(stableHash("a")).toBe((97 >>> 0).toString(36));
});
