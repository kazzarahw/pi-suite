import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildBrowserTool } from "../src/tools.ts";
import type { ExecFn } from "../src/browser.ts";

const ctx = {} as unknown as ExtensionContext;

test("execute runs the action via runBrowser and wraps its stdout", async () => {
  let seenArgs: string[] | undefined;
  const exec: ExecFn = async (_cmd, args) => {
    seenArgs = args;
    return { stdout: "PAGE TEXT", stderr: "", code: 0 };
  };
  const tool = buildBrowserTool({ loadConfig: () => ({ binPath: "agent-browser" }), exec });
  const r = await tool.execute("id", { action: "open", url: "https://x.com" }, undefined, undefined, ctx);
  expect((r.content[0] as { text: string }).text).toBe("PAGE TEXT");
  expect(seenArgs).toEqual(["open", "https://x.com"]);
  expect(r.details.action).toBe("open");
});

test("execute shows (no output) when the command returns nothing", async () => {
  const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
  const tool = buildBrowserTool({ loadConfig: () => ({ binPath: "agent-browser" }), exec });
  const r = await tool.execute("id", { action: "reload" }, undefined, undefined, ctx);
  expect((r.content[0] as { text: string }).text).toBe("(no output)");
});
