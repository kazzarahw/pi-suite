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
  const idx = formatIndexInjection([m("a-fact", "a desc", "the secret body")]);
  expect(idx).toContain("<pi-memory>");
  expect(idx).toContain("a-fact");
  expect(idx).toContain("a desc");
  expect(idx).not.toContain("the secret body");
  expect(formatIndexInjection([])).toBe("");
});

test("formatRecall includes full bodies", () => {
  const rec = formatRecall([m("a-fact", "a desc", "the full body")]);
  expect(rec).toContain("<pi-memory>");
  expect(rec).toContain("the full body");
});
