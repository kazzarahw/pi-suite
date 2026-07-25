import { test, expect } from "bun:test";
import { cwdOf } from "../cwd.ts";

/**
 * The four shapes below are not hypothetical — each occurs at a live call site.
 * The idiom `ctx?.sessionManager?.getCwd?.()` was copy-pasted verbatim into four
 * files and missed five others, which is how the cwd defects happened. Every
 * level of that optional chain is load-bearing, so every level gets a test.
 */

test("returns the session cwd when the context provides one", () => {
  expect(cwdOf({ sessionManager: { getCwd: () => "/tmp/session" } })).toBe("/tmp/session");
});

test("falls back to process.cwd() when there is no context at all", () => {
  // Bus callbacks and some hooks are invoked with no ctx.
  expect(cwdOf(undefined)).toBe(process.cwd());
  expect(cwdOf()).toBe(process.cwd());
});

test("falls back when the context has no sessionManager", () => {
  expect(cwdOf({})).toBe(process.cwd());
});

test("falls back when sessionManager has no getCwd", () => {
  expect(cwdOf({ sessionManager: {} })).toBe(process.cwd());
});

test("does not cache — a later call sees a changed session cwd", () => {
  // pi-lens captured cwd once at extension-load time, which made every LSP query
  // root-relative to the wrong project for the whole session.
  let dir = "/tmp/one";
  const ctx = { sessionManager: { getCwd: () => dir } };
  expect(cwdOf(ctx)).toBe("/tmp/one");
  dir = "/tmp/two";
  expect(cwdOf(ctx)).toBe("/tmp/two");
});
