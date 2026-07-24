import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, saveConfig, type TodoConfig } from "../src/config.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "pi-todo-cfg-")), "pi-todo.json");

test("loadConfig returns DEFAULTS when the file is missing", () => {
  expect(loadConfig(tmp())).toEqual(DEFAULTS);
});

test("saveConfig then loadConfig round-trips", () => {
  const p = tmp();
  const cfg: TodoConfig = { mode: "block" };
  saveConfig(cfg, p);
  expect(loadConfig(p)).toEqual(cfg);
});

test("loadConfig falls back to DEFAULTS on invalid JSON", () => {
  const p = tmp();
  writeFileSync(p, "not json{");
  expect(loadConfig(p)).toEqual(DEFAULTS);
});

test("loadConfig rejects an invalid mode", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ mode: "nope" }));
  expect(loadConfig(p)).toEqual(DEFAULTS);
});
