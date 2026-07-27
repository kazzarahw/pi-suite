import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildBrowserTool, describeCall } from "../src/tools.ts";
import type { ExecFn } from "../../shared/exec.ts";

const ctx = {} as unknown as ExtensionContext;

test("execute runs the action via runBrowser and wraps its stdout", async () => {
  let seenArgs: string[] | undefined;
  const exec: ExecFn = async (_cmd, args) => {
    seenArgs = args;
    return { stdout: "PAGE TEXT", stderr: "", code: 0, killed: false };
  };
  const tool = buildBrowserTool({ loadConfig: () => ({ binPath: "agent-browser" }), exec });
  const r = await tool.execute("id", { action: "open", url: "https://x.com" }, undefined, undefined, ctx);
  expect((r.content[0] as { text: string }).text).toBe("PAGE TEXT");
  expect(seenArgs).toEqual(["open", "https://x.com"]);
  expect(r.details.action).toBe("open");
});

test("execute shows (no output) when the command returns nothing", async () => {
  const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
  const tool = buildBrowserTool({ loadConfig: () => ({ binPath: "agent-browser" }), exec });
  const r = await tool.execute("id", { action: "reload" }, undefined, undefined, ctx);
  expect((r.content[0] as { text: string }).text).toBe("(no output)");
});

// --- What the user sees ----------------------------------------------------
//
// Pi's default renderer knows the shape of its own built-in tools — a `read` row shows
// the path, a `bash` row the command — but a custom tool renders as its bare name. Every
// browser call appeared as the word `browser` and nothing else, immediately followed by a
// screenful of page text, so the one thing worth knowing was the one thing not shown.

test("describeCall names the action and its target", () => {
  expect(describeCall({ action: "search", query: "pi extensions" })).toBe("search pi extensions");
  expect(describeCall({ action: "open", url: "https://pi.dev" })).toBe("open https://pi.dev");
  expect(describeCall({ action: "click", ref: "@ref12" })).toBe("click @ref12");
  expect(describeCall({ action: "get", what: "title" })).toBe("get title");
  expect(describeCall({ action: "scroll", direction: "down" })).toBe("scroll down");
});

test("describeCall falls back to the bare action when there is no target", () => {
  expect(describeCall({ action: "snapshot" })).toBe("snapshot");
  expect(describeCall({ action: "back" })).toBe("back");
});

test("the browser tool reports progress and always clears it", async () => {
  const status: Array<string | undefined> = [];
  const ctx = {
    ui: { setStatus: (_id: string, text?: string) => void status.push(text) },
  } as unknown as ExtensionContext;

  const exec: ExecFn = async () => ({ stdout: "ok", stderr: "", code: 0, killed: false });
  const tool = buildBrowserTool({ loadConfig: () => ({ binPath: "agent-browser" }), exec });
  await tool.execute("id", { action: "open", url: "https://x.com" }, undefined, undefined, ctx);

  expect(status[0]).toContain("open https://x.com");
  expect(status.at(-1)).toBeUndefined();
});

test("a failed action clears its status rather than leaving a page loading forever", async () => {
  const status: Array<string | undefined> = [];
  const ctx = {
    ui: { setStatus: (_id: string, text?: string) => void status.push(text) },
  } as unknown as ExtensionContext;

  const exec: ExecFn = async () => ({ stdout: "", stderr: "boom", code: 1, killed: false });
  const tool = buildBrowserTool({ loadConfig: () => ({ binPath: "agent-browser" }), exec });
  await expect(
    tool.execute("id", { action: "open", url: "https://x.com" }, undefined, undefined, ctx),
  ).rejects.toThrow();

  expect(status.at(-1)).toBeUndefined();
});
