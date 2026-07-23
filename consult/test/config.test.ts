import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, saveConfig, type ConsultConfig } from "../src/config.ts";

function tmpCfgPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-consult-")), "pi-consult.json");
}

test("loadConfig returns DEFAULTS when the file is missing", () => {
  expect(loadConfig(tmpCfgPath())).toEqual(DEFAULTS);
});

test("saveConfig then loadConfig round-trips", () => {
  const path = tmpCfgPath();
  const cfg: ConsultConfig = { defaultModel: "sonnet", allowedModels: ["sonnet", "opus"] };
  saveConfig(cfg, path);
  expect(loadConfig(path)).toEqual(cfg);
});

test("loadConfig falls back to DEFAULTS on invalid JSON", () => {
  const path = tmpCfgPath();
  writeFileSync(path, "not json{");
  expect(loadConfig(path)).toEqual(DEFAULTS);
});

test("loadConfig backfills missing fields from DEFAULTS", () => {
  const path = tmpCfgPath();
  writeFileSync(path, JSON.stringify({ defaultModel: "haiku" }));
  expect(loadConfig(path)).toEqual({ defaultModel: "haiku", allowedModels: DEFAULTS.allowedModels });
});
