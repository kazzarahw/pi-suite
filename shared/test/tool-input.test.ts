import { test, expect } from "bun:test";
import { EDIT_TOOLS, FILE_TOOLS, editedPath } from "../tool-input.ts";

/**
 * Reading a file tool's path out of an untyped `event.input`.
 *
 * pi-git and pi-lens disagreed here: pi-lens accepted `path` and `file_path`, pi-git
 * accepted only `path`, so a file edited through the other key was never checkpointed
 * and a later rewind silently left it as it was. The `file_path` cases below are that
 * defect, pinned.
 */

test("reads the `path` key", () => {
  expect(editedPath({ path: "src/a.ts" })).toBe("src/a.ts");
});

test("reads the `file_path` key — the spelling pi-git used to miss", () => {
  expect(editedPath({ file_path: "src/b.ts" })).toBe("src/b.ts");
});

test("prefers `path` when a call carries both", () => {
  expect(editedPath({ path: "chosen.ts", file_path: "other.ts" })).toBe("chosen.ts");
});

test("falls through to `file_path` when `path` is present but unusable", () => {
  expect(editedPath({ path: "", file_path: "fallback.ts" })).toBe("fallback.ts");
  expect(editedPath({ path: undefined, file_path: "fallback.ts" })).toBe("fallback.ts");
});

test("yields null for inputs carrying no usable path", () => {
  // Every one of these reached the hooks in practice: a tool with different params, a
  // malformed call, or no input at all. None may be treated as a path.
  for (const input of [undefined, null, {}, { path: "" }, { path: 42 }, { path: null }, "a string"]) {
    expect(editedPath(input)).toBeNull();
  }
});

test("EDIT_TOOLS is the write set; FILE_TOOLS additionally includes read", () => {
  expect([...EDIT_TOOLS].sort()).toEqual(["edit", "write"]);
  expect([...FILE_TOOLS].sort()).toEqual(["edit", "read", "write"]);
  // The relationship matters: pi-git checkpoints edits only, pi-lens reports on reads
  // too, and every EDIT tool must therefore also be a FILE tool.
  for (const tool of EDIT_TOOLS) expect(FILE_TOOLS.has(tool)).toBe(true);
  expect(EDIT_TOOLS.has("read")).toBe(false);
});
