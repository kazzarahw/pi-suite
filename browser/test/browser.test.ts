import { test, expect } from "bun:test";
import { browserArgv, runBrowser, looksBlocked, type ExecFn } from "../src/browser.ts";
import type { BrowserConfig } from "../src/config.ts";

test("browserArgv builds the right agent-browser argv per action", () => {
  expect(browserArgv("open", { url: "https://x.com" })).toEqual(["open", "https://x.com"]);
  expect(browserArgv("read", {})).toEqual(["read"]);
  expect(browserArgv("read", { url: "https://x.com" })).toEqual(["read", "https://x.com"]);
  expect(browserArgv("search", { query: "agent browser cli" })).toEqual([
    "read",
    "https://html.duckduckgo.com/html/?q=agent%20browser%20cli",
  ]);
  expect(browserArgv("snapshot", {})).toEqual(["snapshot", "-i"]);
  expect(browserArgv("click", { ref: "@e2" })).toEqual(["click", "@e2"]);
  expect(browserArgv("type", { ref: "@e3", text: "hi" })).toEqual(["type", "@e3", "hi"]);
  expect(browserArgv("fill", { ref: "@e3", text: "hi" })).toEqual(["fill", "@e3", "hi"]);
  expect(browserArgv("press", { key: "Enter" })).toEqual(["press", "Enter"]);
  expect(browserArgv("select", { ref: "@e1", values: ["a", "b"] })).toEqual(["select", "@e1", "a", "b"]);
  expect(browserArgv("scroll", { direction: "up", amount: 300 })).toEqual(["scroll", "up", "300"]);
  expect(browserArgv("scroll", {})).toEqual(["scroll", "down"]);
  expect(browserArgv("wait", { wait: "2000" })).toEqual(["wait", "2000"]);
  expect(browserArgv("screenshot", { path: "/tmp/s.png" })).toEqual(["screenshot", "/tmp/s.png"]);
  expect(browserArgv("back", {})).toEqual(["back"]);
  expect(browserArgv("get", { what: "title" })).toEqual(["get", "title"]);
  expect(browserArgv("get", { what: "text", ref: "@e1" })).toEqual(["get", "text", "@e1"]);
});

test("browserArgv throws on a missing required arg", () => {
  expect(() => browserArgv("open", {})).toThrow('"url" is required');
  expect(() => browserArgv("click", {})).toThrow('"ref" is required');
  expect(() => browserArgv("search", {})).toThrow('"query" is required');
  expect(() => browserArgv("select", { ref: "@e1" })).toThrow('"values" is required');
});

test("runBrowser runs binPath + argv, returns trimmed stdout, prepends session", async () => {
  let captured: { cmd: string; args: string[] } | undefined;
  const exec: ExecFn = async (cmd, args) => {
    captured = { cmd, args };
    return { stdout: "  page text \n", stderr: "", code: 0 };
  };
  const cfg: BrowserConfig = { binPath: "agent-browser", session: "s1" };
  const out = await runBrowser("open", { url: "https://x.com" }, cfg, exec);
  expect(out).toBe("page text");
  expect(captured).toEqual({ cmd: "agent-browser", args: ["--session", "s1", "open", "https://x.com"] });
});

test("runBrowser throws with stderr text on a non-zero exit", async () => {
  const exec: ExecFn = async () => ({ stdout: "", stderr: "boom", code: 3 });
  await expect(runBrowser("snapshot", {}, { binPath: "agent-browser" }, exec)).rejects.toThrow("boom");
});

test("looksBlocked flags bot-walls and tiny output, not real results", () => {
  expect(looksBlocked("")).toBe(true);
  expect(looksBlocked("Please complete the CAPTCHA to continue")).toBe(true);
  expect(looksBlocked("Wait A Moment — we're seeing unusual traffic")).toBe(true);
  expect(
    looksBlocked("GitHub - mvdan/sh: a shell parser and formatter\ngithub.com/mvdan/sh\nIncludes shfmt for formatting."),
  ).toBe(false);
});

test("runBrowser search falls back to the next engine when the first is blocked", async () => {
  const seen: string[] = [];
  const exec: ExecFn = async (_cmd, args) => {
    const url = args[args.length - 1]!;
    seen.push(url);
    if (url.includes("duckduckgo")) return { stdout: "unusual traffic detected, wait a moment", stderr: "", code: 0 };
    return { stdout: "1. Result title\nexample.com\nA real snippet for the query goes here.", stderr: "", code: 0 };
  };
  const out = await runBrowser("search", { query: "x" }, { binPath: "agent-browser" }, exec);
  expect(out).toContain("Result title");
  expect(seen[0]).toContain("duckduckgo");
  expect(seen[1]).toContain("bing");
});

test("runBrowser search requires a query", async () => {
  const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
  await expect(runBrowser("search", {}, { binPath: "agent-browser" }, exec)).rejects.toThrow('"query" is required');
});
