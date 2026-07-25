import { test, expect } from "bun:test";
import { composeToolResult, feedbackBlocks, gatherFeedback, type Gathered } from "../src/feedback.ts";
import type { LspManager } from "../src/lsp/manager.ts";
import type { ExecFn } from "../../shared/exec.ts";
import type { Diagnostic } from "../src/diagnostics.ts";

/**
 * Post-edit feedback: gathering it, and folding it into a tool result.
 *
 * The `unavailable` cases are the reason this was worth extracting. A crashed language
 * server and a clean file both produced an empty diagnostics list, so a failed pull read
 * as "no errors" — which cleared pi-lens's error flag and let the next settle run the
 * test suite against code nothing had checked.
 */

const DIAG: Diagnostic = {
  file: "/p/a.ts",
  line: 1,
  col: 1,
  severity: "error",
  message: "boom",
  source: "ts",
};

const okExec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

const manager = (pull: () => Promise<Diagnostic[]>): LspManager =>
  ({ pull, ready: async () => null, shutdownAll: async () => {} }) as unknown as LspManager;

const base = {
  file: "/p/a.ts",
  rel: "a.ts",
  cwd: "/p",
  toolchain: null,
  isEdit: false,
  autoFormat: false,
  exec: okExec,
};

test("gathers diagnostics from the language server", async () => {
  const got = await gatherFeedback({ ...base, manager: manager(async () => [DIAG]) });
  expect(got.diagnostics).toEqual([DIAG]);
  expect(got.unavailable).toBe(false);
});

test("a clean file reports no diagnostics and stays available", async () => {
  const got = await gatherFeedback({ ...base, manager: manager(async () => []) });
  expect(got.diagnostics).toEqual([]);
  expect(got.unavailable).toBe(false);
});

test("a throwing language server is reported as unavailable, not as clean", async () => {
  const got = await gatherFeedback({
    ...base,
    manager: manager(async () => {
      throw new Error("server died");
    }),
  });
  expect(got.diagnostics).toEqual([]);
  expect(got.unavailable).toBe(true);
});

test("gathering never throws, whatever the language server does", async () => {
  // The hook that calls this is in the path of every read and edit; a throw here would
  // break the tool call that triggered it.
  const got = gatherFeedback({
    ...base,
    manager: manager(() => Promise.reject(new Error("wedged"))),
  });
  await expect(got).resolves.toBeDefined();
});

test("a formatter that changes the file produces a reformat note", async () => {
  const got = await gatherFeedback({
    ...base,
    isEdit: true,
    autoFormat: true,
    toolchain: { linters: [], formatter: { name: "prettier", cmd: () => ["true"] } },
    manager: manager(async () => []),
  });
  // No real file on disk, so `runFormatter` reads nothing and reports no change — the
  // note stays empty rather than the call failing.
  expect(got.reformatNote).toBe("");
  expect(got.unavailable).toBe(false);
});

test("auto-format is skipped for a read, even when enabled", async () => {
  let ran = false;
  const spy: ExecFn = async () => {
    ran = true;
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  await gatherFeedback({
    ...base,
    isEdit: false,
    autoFormat: true,
    exec: spy,
    toolchain: { linters: [], formatter: { name: "prettier", cmd: () => ["prettier"] } },
    manager: manager(async () => []),
  });
  expect(ran).toBe(false);
});

// --- composing ------------------------------------------------------------

const gathered = (over: Partial<Gathered> = {}): Gathered => ({
  diagnostics: [],
  reformatNote: "",
  unavailable: false,
  ...over,
});

test("no diagnostics and no reformat means no blocks at all", () => {
  expect(feedbackBlocks("a.ts", gathered())).toEqual([]);
});

test("diagnostics come before the reformat note", () => {
  const blocks = feedbackBlocks("a.ts", gathered({ diagnostics: [DIAG], reformatNote: "NOTE" }));
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toContain("boom");
  expect(blocks[1]).toBe("NOTE");
});

test("composeToolResult returns undefined when there is nothing to add", () => {
  // The hook reads that as "leave the tool's result exactly as it was" — not as a
  // result with an empty line appended to it.
  expect(composeToolResult({ content: [{ type: "text", text: "out" }] }, [])).toBeUndefined();
});

test("composeToolResult appends one text part and preserves the original content", () => {
  const event = { content: [{ type: "text", text: "tool output" }], details: { a: 1 }, isError: false };
  const out = composeToolResult(event, ["BLOCK"])!;
  expect(out.content).toHaveLength(2);
  expect(out.content[0]).toBe(event.content[0]!);
  expect(out.content[1]).toEqual({ type: "text", text: "\nBLOCK" });
});

test("composeToolResult carries details and isError through untouched", () => {
  const out = composeToolResult(
    { content: [], details: { keys: ["x"] }, isError: true },
    ["B"],
  )!;
  expect(out.details).toEqual({ keys: ["x"] });
  expect(out.isError).toBe(true);
});

test("composeToolResult joins several blocks with newlines", () => {
  const out = composeToolResult({ content: [] }, ["one", "two"])!;
  expect((out.content[0] as { text: string }).text).toBe("\none\ntwo");
});

test("composeToolResult does not mutate the event it was given", () => {
  const event = { content: [{ type: "text", text: "x" }] };
  composeToolResult(event, ["B"]);
  expect(event.content).toHaveLength(1);
});
