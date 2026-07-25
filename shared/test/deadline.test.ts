import { test, expect } from "bun:test";
import { deadline } from "../deadline.ts";
import { within } from "./harness.ts";

/**
 * Two independent reasons to stop waiting — the user pressed Esc, or the operation
 * outlived its bound — and callers must honor both. Threading them separately is how
 * the lens tool ended up honoring neither: it received an AbortSignal and discarded it.
 */

const aborted = (s: AbortSignal): Promise<void> =>
  s.aborted ? Promise.resolve() : new Promise((r) => s.addEventListener("abort", () => r(), { once: true }));

test("aborts when the parent signal aborts, before the deadline elapses", async () => {
  const ac = new AbortController();
  const s = deadline(10_000, ac.signal);
  expect(s.aborted).toBe(false);
  ac.abort();
  await within(1000, aborted(s));
  expect(s.aborted).toBe(true);
});

test("aborts when the deadline elapses, with no parent involved", async () => {
  const s = deadline(30);
  expect(s.aborted).toBe(false);
  await within(1000, aborted(s));
  expect(s.aborted).toBe(true);
});

test("aborts on the deadline even when a parent is supplied and never fires", async () => {
  const ac = new AbortController();
  const s = deadline(30, ac.signal);
  await within(1000, aborted(s));
  expect(s.aborted).toBe(true);
  expect(ac.signal.aborted).toBe(false);
});

test("an already-aborted parent produces an already-aborted signal", () => {
  expect(deadline(10_000, AbortSignal.abort()).aborted).toBe(true);
});

test("does not abort before either cause fires", async () => {
  const ac = new AbortController();
  const s = deadline(5_000, ac.signal);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.aborted).toBe(false);
});
