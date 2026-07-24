import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, saveConfig, type MemoryConfig } from "../src/config.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "pi-memory-cfg-")), "pi-memory.json");

test("loadConfig returns DEFAULTS when the file is missing", () => {
  expect(loadConfig(tmp())).toEqual(DEFAULTS);
});

test("saveConfig then loadConfig round-trips", () => {
  const p = tmp();
  const cfg: MemoryConfig = { mode: "off", autoCapture: true, recallLimit: 5 };
  saveConfig(cfg, p);
  expect(loadConfig(p)).toEqual(cfg);
});

test("loadConfig falls back to DEFAULTS on invalid JSON", () => {
  const p = tmp();
  writeFileSync(p, "not json{");
  expect(loadConfig(p)).toEqual(DEFAULTS);
});

test("loadConfig rejects a sub-1 recallLimit and an invalid mode, keeping other fields", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ mode: "nope", autoCapture: true, recallLimit: 0 }));
  expect(loadConfig(p)).toEqual({ ...DEFAULTS, autoCapture: true });
});
