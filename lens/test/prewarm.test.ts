import { test, expect } from "bun:test";
import { discoverWarmTargets } from "../src/prewarm.ts";
import { DEFAULT_TOOLCHAINS } from "../src/toolchains.ts";

test("discoverWarmTargets picks one file per distinct installed server", () => {
  const which = (bin: string) => bin === "typescript-language-server" || bin === "pyright-langserver";
  const files = ["/w/a.ts", "/w/b.tsx", "/w/c.py", "/w/d.py", "/w/e.rs", "/w/f.md"];
  // ts + tsx share tsserver → one target; py → one; rust-analyzer not installed → skipped; md has no LSP → skipped.
  expect(discoverWarmTargets(DEFAULT_TOOLCHAINS, which, files)).toEqual(["/w/a.ts", "/w/c.py"]);
});

test("discoverWarmTargets returns nothing when no server binary is present", () => {
  expect(discoverWarmTargets(DEFAULT_TOOLCHAINS, () => false, ["/w/a.ts", "/w/b.py"])).toEqual([]);
});

test("discoverWarmTargets probes each server binary at most once", () => {
  const calls: string[] = [];
  const which = (bin: string) => {
    calls.push(bin);
    return true;
  };
  discoverWarmTargets(DEFAULT_TOOLCHAINS, which, ["/w/a.ts", "/w/b.ts", "/w/c.ts", "/w/d.py"]);
  expect(calls.filter((b) => b === "typescript-language-server")).toHaveLength(1);
  expect(calls.filter((b) => b === "pyright-langserver")).toHaveLength(1);
});
