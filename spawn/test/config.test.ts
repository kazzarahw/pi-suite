import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, saveConfig, type SpawnConfig } from "../src/config.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "pi-spawn-cfg-")), "pi-spawn.json");

test("loadConfig returns DEFAULTS when the file is missing", () => {
  expect(loadConfig(tmp())).toEqual(DEFAULTS);
});

test("saveConfig then loadConfig round-trips", () => {
  const p = tmp();
  const cfg: SpawnConfig = { defaultModel: "opus", concurrency: 8 };
  saveConfig(cfg, p);
  expect(loadConfig(p)).toEqual(cfg);
});

test("loadConfig falls back to DEFAULTS on invalid JSON", () => {
  const p = tmp();
  writeFileSync(p, "not json{");
  expect(loadConfig(p)).toEqual(DEFAULTS);
});

test("loadConfig floors a fractional concurrency and rejects non-string/sub-1 values", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ concurrency: 3.9, defaultModel: 5 }));
  expect(loadConfig(p)).toEqual({ defaultModel: "", concurrency: 3 });
});
