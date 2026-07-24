import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { agentDir, configPath, loadConfig, saveConfig, type ConfigSpec } from "../config.ts";

import { SPEC as CONSULT, DEFAULTS as CONSULT_DEFAULTS } from "../../consult/src/config.ts";
import { SPEC as TODO, DEFAULTS as TODO_DEFAULTS } from "../../todo/src/config.ts";
import { SPEC as GIT, DEFAULTS as GIT_DEFAULTS } from "../../git/src/config.ts";
import { SPEC as SPAWN, DEFAULTS as SPAWN_DEFAULTS } from "../../spawn/src/config.ts";
import { SPEC as BROWSER, DEFAULTS as BROWSER_DEFAULTS } from "../../browser/src/config.ts";
import { SPEC as MEMORY, DEFAULTS as MEMORY_DEFAULTS } from "../../memory/src/config.ts";
import { SPEC as LENS, DEFAULTS as LENS_DEFAULTS } from "../../lens/src/config.ts";

const tmp = (name: string): string => join(mkdtempSync(join(tmpdir(), `pi-suite-cfg-`)), `pi-${name}.json`);

/* eslint-disable @typescript-eslint/no-explicit-any -- the table is heterogeneous by design */
const SPECS: Array<ConfigSpec<any>> = [CONSULT, TODO, GIT, SPAWN, BROWSER, MEMORY, LENS];

// ---------------------------------------------------------------------------
// Generic mechanism — every assertion class the seven per-extension suites had,
// now run once per spec.
// ---------------------------------------------------------------------------

for (const spec of SPECS) {
  test(`[${spec.name}] loadConfig returns DEFAULTS when the file is missing`, () => {
    expect(loadConfig(spec, tmp(spec.name))).toEqual(spec.defaults);
  });

  test(`[${spec.name}] saveConfig then loadConfig round-trips`, () => {
    const path = tmp(spec.name);
    saveConfig(spec, spec.defaults, path);
    expect(loadConfig(spec, path)).toEqual(spec.defaults);
  });

  test(`[${spec.name}] loadConfig falls back to DEFAULTS on invalid JSON`, () => {
    const path = tmp(spec.name);
    writeFileSync(path, "not json{");
    expect(loadConfig(spec, path)).toEqual(spec.defaults);
  });

  test(`[${spec.name}] configPath lands under the agent dir and is named pi-<name>.json`, () => {
    expect(configPath(spec.name)).toBe(join(agentDir(), `pi-${spec.name}.json`));
  });
}

// ---------------------------------------------------------------------------
// Path resolution — the D5 convergence: all seven now honor PI_CODING_AGENT_DIR
// (previously only pi-lens and pi-memory did).
// ---------------------------------------------------------------------------

test("agentDir honors PI_CODING_AGENT_DIR when set", () => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi-suite-custom-agent-dir";
  try {
    expect(agentDir()).toBe("/tmp/pi-suite-custom-agent-dir");
    for (const spec of SPECS) {
      expect(configPath(spec.name)).toBe(`/tmp/pi-suite-custom-agent-dir/pi-${spec.name}.json`);
    }
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("agentDir falls back to ~/.pi/agent when PI_CODING_AGENT_DIR is unset", () => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    expect(agentDir()).toBe(join(homedir(), ".pi", "agent"));
  } finally {
    if (prev !== undefined) process.env.PI_CODING_AGENT_DIR = prev;
  }
});

// ---------------------------------------------------------------------------
// Per-extension validation — carried over verbatim from the seven deleted suites.
// Each extension keeps its own `parse`, so each keeps its own test.
// ---------------------------------------------------------------------------

test("[consult] loadConfig backfills missing fields from DEFAULTS", () => {
  const path = tmp("consult");
  writeFileSync(path, JSON.stringify({ defaultModel: "haiku" }));
  expect(loadConfig(CONSULT, path)).toEqual({
    defaultModel: "haiku",
    allowedModels: CONSULT_DEFAULTS.allowedModels,
  });
});

test("[todo] loadConfig rejects an invalid mode", () => {
  const path = tmp("todo");
  writeFileSync(path, JSON.stringify({ mode: "nope" }));
  expect(loadConfig(TODO, path)).toEqual(TODO_DEFAULTS);
});

test("[git] loadConfig backfills nested worktree fields and rejects an invalid mode", () => {
  const path = tmp("git");
  writeFileSync(path, JSON.stringify({ mode: "nope", worktrees: { auto: true } }));
  expect(loadConfig(GIT, path)).toEqual({
    mode: GIT_DEFAULTS.mode,
    worktrees: { auto: true, baseDir: GIT_DEFAULTS.worktrees.baseDir },
  });
});

test("[spawn] loadConfig floors a fractional concurrency and rejects non-string/sub-1 values", () => {
  const path = tmp("spawn");
  writeFileSync(path, JSON.stringify({ concurrency: 3.9, defaultModel: 5 }));
  expect(loadConfig(SPAWN, path)).toEqual({ defaultModel: "", concurrency: 3 });
});

test("[browser] empty binPath falls back to default; empty session becomes undefined", () => {
  const path = tmp("browser");
  writeFileSync(path, JSON.stringify({ binPath: "", session: "" }));
  const cfg = loadConfig(BROWSER, path);
  expect(cfg.binPath).toBe("agent-browser");
  expect(cfg.session).toBeUndefined();
});

test("[memory] loadConfig rejects a sub-1 recallLimit and an invalid mode, keeping other fields", () => {
  const path = tmp("memory");
  writeFileSync(path, JSON.stringify({ mode: "nope", autoCapture: true, recallLimit: 0 }));
  expect(loadConfig(MEMORY, path)).toEqual({ ...MEMORY_DEFAULTS, autoCapture: true });
});

test("[lens] loadConfig backfills missing fields and rejects an invalid mode", () => {
  const path = tmp("lens");
  writeFileSync(path, JSON.stringify({ mode: "bogus", autoFormat: true }));
  expect(loadConfig(LENS, path)).toEqual({ ...LENS_DEFAULTS, autoFormat: true });
});

test("SPECS covers every extension that has config", () => {
  expect(SPECS.map((s) => s.name).sort()).toEqual(
    ["browser", "consult", "git", "lens", "memory", "spawn", "todo"],
  );
});
