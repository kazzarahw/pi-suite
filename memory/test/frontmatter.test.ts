import { test, expect } from "bun:test";
import { parseMemory, serializeMemory, type Memory } from "../src/frontmatter.ts";

test("serializeMemory -> parseMemory round-trips name/description/type/body", () => {
  const m: Memory = {
    name: "x-fact",
    description: "a fact",
    type: "project",
    scope: "global",
    body: "The body.\nLine two.",
  };
  expect(parseMemory(serializeMemory(m))).toEqual({
    name: "x-fact",
    description: "a fact",
    type: "project",
    body: "The body.\nLine two.",
  });
});

test("parseMemory returns null without frontmatter or a name", () => {
  expect(parseMemory("no frontmatter")).toBeNull();
  expect(parseMemory("---\ndescription: x\n---\nbody")).toBeNull();
});

test("parseMemory defaults an unknown/missing type to reference", () => {
  expect(parseMemory("---\nname: n\n---\nbody")!.type).toBe("reference");
  expect(parseMemory("---\nname: n\ntype: bogus\n---\nbody")!.type).toBe("reference");
});
