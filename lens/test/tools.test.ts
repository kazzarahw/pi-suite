import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLensTool } from "../src/tools.ts";
import type { LspClient } from "../src/lsp/client.ts";
import type { LspManager } from "../src/lsp/manager.ts";

/** A lens tool whose manager hands back this (partial) client — or null for "no server". */
function toolWith(client: Partial<LspClient> | null) {
  const manager = { ready: async () => client } as unknown as LspManager;
  return buildLensTool({ manager: () => manager });
}
type LensTool = ReturnType<typeof buildLensTool>;
const run = (tool: LensTool, params: Parameters<LensTool["execute"]>[1]) =>
  tool.execute("id", params, undefined, undefined, {} as unknown as ExtensionContext);
const textOf = (r: { content: Array<unknown> }) => (r.content[0] as { text: string }).text;

test("hover returns the client's hover text, or a placeholder when empty", async () => {
  expect(textOf(await run(toolWith({ hover: async () => "const x: number" }), { action: "hover", path: "/x.ts", line: 1, col: 1 }))).toBe("const x: number");
  expect(textOf(await run(toolWith({ hover: async () => null }), { action: "hover", path: "/x.ts", line: 1, col: 1 }))).toContain("no hover info");
});

test("references format as file:line:col, and empty → (none found)", async () => {
  expect(textOf(await run(toolWith({ references: async () => [{ file: "/a.ts", line: 3, col: 5 }] }), { action: "references", path: "/a.ts", line: 1, col: 1 }))).toBe("/a.ts:3:5");
  expect(textOf(await run(toolWith({ references: async () => [] }), { action: "references", path: "/a.ts", line: 1, col: 1 }))).toBe("(none found)");
});

test("rename requires new_name", async () => {
  await expect(run(toolWith({ rename: async () => [] }), { action: "rename", path: "/a.ts", line: 1, col: 1 })).rejects.toThrow("new_name");
});

test("rename summarizes touched files and edit counts", async () => {
  const tool = toolWith({ rename: async () => [{ file: "/a.ts", edits: [{}, {}] }] });
  expect(textOf(await run(tool, { action: "rename", path: "/a.ts", line: 1, col: 1, new_name: "y" }))).toContain("/a.ts (2 edit(s))");
});

test("throws when no language server is configured for the file", async () => {
  await expect(run(toolWith(null), { action: "hover", path: "/x.unknown", line: 1, col: 1 })).rejects.toThrow("no language server");
});
