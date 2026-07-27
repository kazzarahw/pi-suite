import { test, expect } from "bun:test";
import { selectByQuery, formatIndexInjection, formatRecall } from "../src/recall.ts";
import type { Memory } from "../src/frontmatter.ts";

const m = (name: string, description: string, body: string): Memory => ({
  name,
  description,
  type: "reference",
  scope: "global",
  body,
});

test("selectByQuery ranks by term overlap, caps at limit, drops non-matches", () => {
  const mems = [m("a", "tabs preference", "user likes tabs"), m("b", "colors", "blue"), m("c", "tabs and spaces", "tabs tabs")];
  const res = selectByQuery(mems, "tabs", 5);
  expect(res.map((x) => x.name).sort()).toEqual(["a", "c"]);
  expect(selectByQuery(mems, "tabs", 1)).toHaveLength(1);
  expect(selectByQuery(mems, "nonexistentterm", 5)).toEqual([]);
});

test("formatIndexInjection is names+descriptions only, wrapped in <pi-memory>", () => {
  const idx = formatIndexInjection([m("a-fact", "a desc", "the secret body")], 50);
  expect(idx).toContain("<pi-memory>");
  expect(idx).toContain("a-fact");
  expect(idx).toContain("a desc");
  expect(idx).not.toContain("the secret body");
  expect(formatIndexInjection([], 50)).toBe("");
});

test("formatRecall includes full bodies", () => {
  const rec = formatRecall([m("a-fact", "a desc", "the full body")]);
  expect(rec).toContain("a-fact");
  expect(rec).toContain("the full body");
});

/**
 * A tool result is not a context injection.
 *
 * The tags mark output the harness pushed in unasked, so the model does not read it as
 * user text. A recall is a tool result: already attributed, already labelled by Pi with
 * the tool that produced it. Wrapping it only meant the user read `<pi-memory>` in their
 * transcript, because Pi's default `renderResult` prints the text verbatim.
 */
test("formatRecall is plain text — injection tags are for injections", () => {
  const rec = formatRecall([m("a-fact", "a desc", "the full body")]);
  expect(rec).not.toContain("<pi-memory>");
  expect(rec).not.toContain("</pi-memory>");
  expect(rec.startsWith("a-fact")).toBe(true);
});

/**
 * And plain text means markdown too. The same verbatim printing that made `<pi-memory>`
 * visible makes `## name` two literal hashes; the blank line between memories already
 * does what the heading was for.
 */
test("formatRecall heads each memory with a bare name, not a markdown heading", () => {
  const rec = formatRecall([m("a-fact", "d", "body one"), m("b-fact", "d", "body two")]);
  expect(rec).not.toContain("#");
  expect(rec).toBe("a-fact\nbody one\n\nb-fact\nbody two");
});
