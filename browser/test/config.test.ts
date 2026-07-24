import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, saveConfig, type BrowserConfig } from "../src/config.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "pi-browser-cfg-")), "pi-browser.json");

test("loadConfig returns DEFAULTS when the file is missing", () => {
  expect(loadConfig(tmp())).toEqual(DEFAULTS);
});

test("saveConfig then loadConfig round-trips", () => {
  const p = tmp();
  const cfg: BrowserConfig = { binPath: "/opt/agent-browser", session: "s1" };
  saveConfig(cfg, p);
  expect(loadConfig(p)).toEqual(cfg);
});

test("loadConfig falls back to DEFAULTS on invalid JSON", () => {
  const p = tmp();
  writeFileSync(p, "not json{");
  expect(loadConfig(p)).toEqual(DEFAULTS);
});

test("empty binPath falls back to default; empty session becomes undefined", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ binPath: "", session: "" }));
  const cfg = loadConfig(p);
  expect(cfg.binPath).toBe("agent-browser");
  expect(cfg.session).toBeUndefined();
});
