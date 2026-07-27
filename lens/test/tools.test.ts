import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLensTool, describeCall } from "../src/tools.ts";
import { LspUnavailableError, type LspClient } from "../src/lsp/client.ts";
import type { LspManager } from "../src/lsp/manager.ts";

/**
 * A lens tool whose manager hands back this (partial) client — or null for "no server".
 *
 * `exists` is stubbed true because these cases are about what the *server* answers; the
 * file check has its own tests below.
 */
function toolWith(client: Partial<LspClient> | null) {
  const manager = { ready: async () => client } as unknown as LspManager;
  return buildLensTool({ manager: () => manager, exists: () => true });
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

// --- Cancellation and honest failure ---------------------------------------
// The tool received an AbortSignal as `_signal` and discarded it, so a wedged
// language server could be neither cancelled nor timed out — the only recovery was
// killing Pi. It also resolved the cwd from nowhere, so `ready()` was rooted wrong.

test("the tool passes its abort signal through to the client", async () => {
  let seen: AbortSignal | undefined;
  const manager = {
    ready: async () => ({
      references: async (_u: string, _p: unknown, signal?: AbortSignal) => {
        seen = signal;
        return [];
      },
    }),
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const ac = new AbortController();
  await tool.execute(
    "id",
    { action: "references", path: "/a.ts", line: 1, col: 1 },
    ac.signal,
    undefined,
    {} as unknown as ExtensionContext,
  );
  expect(seen).toBeDefined();
  // Not the raw signal: it is combined with the request deadline, so aborting the
  // caller's signal must still abort the one handed to the client.
  ac.abort();
  expect(seen!.aborted).toBe(true);
});

test("the deadline aborts the client's signal even when the caller never cancels", async () => {
  let seen: AbortSignal | undefined;
  const manager = {
    ready: async () => ({
      hover: async (_u: string, _p: unknown, signal?: AbortSignal) => {
        seen = signal;
        return "x";
      },
    }),
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, requestTimeoutMs: 20, exists: () => true });
  await tool.execute("id", { action: "hover", path: "/a.ts", line: 1, col: 1 }, undefined, undefined, {} as unknown as ExtensionContext);
  expect(seen).toBeDefined();
  await new Promise((r) => setTimeout(r, 60));
  expect(seen!.aborted).toBe(true);
});

// The point of rejecting rather than resolving empty: an unavailable server must not
// render as "(none found)", which the agent would read as a definitive answer.
test("an unavailable server surfaces as an error, not as an empty result", async () => {
  const manager = {
    ready: async () => ({
      references: async () => {
        throw new LspUnavailableError("timeout", "textDocument/references", "did not respond");
      },
    }),
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const err = await tool
    .execute("id", { action: "references", path: "/a.ts", line: 1, col: 1 }, undefined, undefined, {} as unknown as ExtensionContext)
    .then(() => null)
    .catch((e: unknown) => e as Error);
  expect(err).toBeTruthy();
  expect(err!.message).not.toContain("none found");
  expect(err!.message.toLowerCase()).toContain("respond");
});

test("the tool resolves cwd from the context, not from process.cwd()", async () => {
  let seenCwd: string | undefined;
  const manager = {
    ready: async (_path: string, cwd: string) => {
      seenCwd = cwd;
      return { hover: async () => "x" };
    },
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const ctx = { sessionManager: { getCwd: () => "/tmp/session-root" } } as unknown as ExtensionContext;
  await tool.execute("id", { action: "hover", path: "/a.ts", line: 1, col: 1 }, undefined, undefined, ctx);
  expect(seenCwd).toBe("/tmp/session-root");
});

// --- Which file, and whose cwd --------------------------------------------

/**
 * THE bug this section exists for.
 *
 * `pathToFileURL` resolves a relative path against `process.cwd()` — the extension
 * host's, not Pi's session cwd. The manager takes `cwd` per call precisely because those
 * differ, so the server was rooted in the right project while the URI named a file in
 * the wrong one, and the query came back `(none found)`: not an error, a confident
 * nothing. Absolute in the assertion because the whole point is that the *session* cwd
 * decides, and the host's cwd is wherever the test runner happens to be.
 */
test("a relative path resolves against the session cwd, not the host's", async () => {
  let seenUri = "";
  const manager = {
    ready: async () => ({
      hover: async (uri: string) => {
        seenUri = uri;
        return "x";
      },
    }),
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const ctx = { sessionManager: { getCwd: () => "/tmp/session-root" } } as unknown as ExtensionContext;
  await tool.execute("id", { action: "hover", path: "src/greet.ts", line: 2, col: 17 }, undefined, undefined, ctx);
  expect(seenUri).toBe("file:///tmp/session-root/src/greet.ts");
});

test("the manager is told the resolved path too, so it roots the right server", async () => {
  let seenPath = "";
  const manager = {
    ready: async (path: string) => {
      seenPath = path;
      return { hover: async () => "x" };
    },
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const ctx = { sessionManager: { getCwd: () => "/tmp/session-root" } } as unknown as ExtensionContext;
  await tool.execute("id", { action: "hover", path: "src/greet.ts", line: 1, col: 1 }, undefined, undefined, ctx);
  expect(seenPath).toBe("/tmp/session-root/src/greet.ts");
});

/**
 * "Nothing checked this" must not arrive as "there is nothing here" — the rule pi-lens
 * already holds its diagnostics to. A typo'd path used to reach the language server,
 * which has nothing to say about a file it cannot open, and the answer was the same
 * placeholder a real symbol with no docs gets.
 */
test("a file that is not there says so, rather than reporting no hover info", async () => {
  const manager = { ready: async () => ({ hover: async () => null }) } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => false });
  await expect(
    tool.execute("id", { action: "hover", path: "src/nope.ts", line: 1, col: 1 }, undefined, undefined, {} as unknown as ExtensionContext),
  ).rejects.toThrow("no such file: src/nope.ts");
});

test("the missing-file check runs before the server is started", async () => {
  let started = false;
  const manager = {
    ready: async () => {
      started = true;
      return { hover: async () => "x" };
    },
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => false });
  await expect(
    tool.execute("id", { action: "hover", path: "gone.ts", line: 1, col: 1 }, undefined, undefined, {} as unknown as ExtensionContext),
  ).rejects.toThrow("no such file");
  expect(started).toBe(false);
});

/**
 * A language server answers in absolute URIs, so the call row said `src/greet.ts:2:17`
 * and the result under it repeated the same file as a full path that wrapped. Inside the
 * project the relative form is shorter and is what `read` takes back.
 */
test("locations inside the project render relative to it", async () => {
  const manager = {
    ready: async () => ({
      definition: async () => [{ file: "/tmp/session-root/src/greet.ts", line: 2, col: 17 }],
    }),
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const ctx = { sessionManager: { getCwd: () => "/tmp/session-root" } } as unknown as ExtensionContext;
  const r = await tool.execute("id", { action: "definition", path: "src/greet.ts", line: 2, col: 17 }, undefined, undefined, ctx);
  expect(textOf(r as { content: Array<unknown> })).toBe("src/greet.ts:2:17");
});

/**
 * And a location *outside* it stays absolute: a definition that landed in a dependency
 * or another checkout is exactly where the full path is the information.
 */
test("a location outside the project keeps its absolute path", async () => {
  const manager = {
    ready: async () => ({
      definition: async () => [{ file: "/usr/lib/node_modules/x/index.d.ts", line: 9, col: 1 }],
    }),
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const ctx = { sessionManager: { getCwd: () => "/tmp/session-root" } } as unknown as ExtensionContext;
  const r = await tool.execute("id", { action: "definition", path: "src/greet.ts", line: 2, col: 17 }, undefined, undefined, ctx);
  expect(textOf(r as { content: Array<unknown> })).toBe("/usr/lib/node_modules/x/index.d.ts:9:1");
});

test("a rename summary uses the same project-relative spelling", async () => {
  const manager = {
    ready: async () => ({
      rename: async () => [{ file: "/tmp/session-root/src/greet.ts", edits: [{}, {}] }],
    }),
  } as unknown as LspManager;
  const tool = buildLensTool({ manager: () => manager, exists: () => true });
  const ctx = { sessionManager: { getCwd: () => "/tmp/session-root" } } as unknown as ExtensionContext;
  const r = await tool.execute("id", { action: "rename", path: "src/greet.ts", line: 2, col: 17, new_name: "hi" }, undefined, undefined, ctx);
  expect(textOf(r as { content: Array<unknown> })).toContain("src/greet.ts (2 edit(s))");
  expect(textOf(r as { content: Array<unknown> })).not.toContain("/tmp/session-root");
});

// The row a user watching actually reads. Pure, so it needs no terminal.
test("describeCall names the action and the position it is asking about", () => {
  expect(describeCall({ action: "hover", path: "src/foo.ts", line: 12, col: 5 } as never)).toBe(
    "hover src/foo.ts:12:5",
  );
  expect(
    describeCall({ action: "rename", path: "a.ts", line: 1, col: 2, new_name: "next" } as never),
  ).toBe("rename a.ts:1:2 \u2192 next");
  // A rename with no target name yet (streaming args) must not render a dangling arrow.
  expect(describeCall({ action: "rename", path: "a.ts", line: 1, col: 2 } as never)).toBe(
    "rename a.ts:1:2",
  );
});
