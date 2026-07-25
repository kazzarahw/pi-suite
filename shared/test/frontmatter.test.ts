import { test, expect } from "bun:test";
import { parseFrontmatter } from "../frontmatter.ts";

/**
 * The one frontmatter parser, shared by pi-memory's memories and pi-spawn's agent
 * definitions. Both read files a user hand-edits, so the malformed cases below are the
 * point of the suite, not an afterthought.
 */

test("splits meta from body", () => {
  const parsed = parseFrontmatter("---\nname: thing\ndescription: a thing\n---\nthe body\n");
  expect(parsed).toEqual({ meta: { name: "thing", description: "a thing" }, body: "the body" });
});

test("returns null when there is no frontmatter block", () => {
  expect(parseFrontmatter("just a body, no fence")).toBeNull();
  expect(parseFrontmatter("")).toBeNull();
  // An opening fence with no closing one is not a block.
  expect(parseFrontmatter("---\nname: x\nstill going")).toBeNull();
});

test("accepts CRLF line endings", () => {
  // Both callers read files that may have been written on Windows or through an editor
  // that normalizes differently than the one that created them.
  const parsed = parseFrontmatter("---\r\nname: crlf\r\n---\r\nbody here\r\n");
  expect(parsed?.meta.name).toBe("crlf");
  expect(parsed?.body).toBe("body here");
});

test("keeps colons inside a value", () => {
  // Values routinely contain colons — a URL, a shell command, a time.
  const parsed = parseFrontmatter("---\ndescription: see https://example.com: really\n---\nb");
  expect(parsed?.meta.description).toBe("see https://example.com: really");
});

test("ignores lines with no colon, and keys with no value become empty strings", () => {
  const parsed = parseFrontmatter("---\nname: x\ngarbage line\nempty:\n---\nb");
  expect(parsed?.meta).toEqual({ name: "x", empty: "" });
});

test("trims surrounding whitespace on keys, values, and the body", () => {
  const parsed = parseFrontmatter("---\n  name  :   spaced   \n---\n\n  padded body  \n\n");
  expect(parsed?.meta.name).toBe("spaced");
  expect(parsed?.body).toBe("padded body");
});

test("an empty body is an empty string, not null", () => {
  const parsed = parseFrontmatter("---\nname: x\n---\n");
  expect(parsed).toEqual({ meta: { name: "x" }, body: "" });
});

test("a later duplicate key wins", () => {
  const parsed = parseFrontmatter("---\nname: first\nname: second\n---\nb");
  expect(parsed?.meta.name).toBe("second");
});

test("a `---` inside the body does not re-open the block", () => {
  // Markdown bodies contain horizontal rules; the parser is non-greedy to the FIRST
  // closing fence, so everything after it is body regardless of what it contains.
  const parsed = parseFrontmatter("---\nname: x\n---\nintro\n\n---\n\noutro");
  expect(parsed?.meta).toEqual({ name: "x" });
  expect(parsed?.body).toBe("intro\n\n---\n\noutro");
});
