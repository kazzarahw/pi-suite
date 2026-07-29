import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { agentDir, configPath, loadConfig, saveConfig, type ConfigSpec } from "../config.ts";

import { SPEC as PLAN, DEFAULTS as PLAN_DEFAULTS } from "../../plan/src/config.ts";
import { SPEC as GIT, DEFAULTS as GIT_DEFAULTS } from "../../git/src/config.ts";
import { SPEC as SPAWN } from "../../spawn/src/config.ts";
import { SPEC as BROWSER } from "../../browser/src/config.ts";
import { SPEC as MEMORY, DEFAULTS as MEMORY_DEFAULTS } from "../../memory/src/config.ts";
import { SPEC as LENS, DEFAULTS as LENS_DEFAULTS } from "../../lens/src/config.ts";

const tmp = (name: string): string => join(mkdtempSync(join(tmpdir(), `pi-suite-cfg-`)), `pi-${name}.json`);

/* eslint-disable @typescript-eslint/no-explicit-any -- the table is heterogeneous by design */
const SPECS: Array<ConfigSpec<any>> = [PLAN, GIT, SPAWN, BROWSER, MEMORY, LENS];

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

test("[plan] loadConfig rejects an invalid mode and a sub-1 nudge or block quota", () => {
  const path = tmp("plan");
  // A quota of zero would mean "never nudge" spelled as a number, and a maxBlocks of zero
  // would arm the gate with no bound at all — `int`'s min of 1 is what stops both.
  writeFileSync(path, JSON.stringify({ mode: "nope", maxNudges: 0, maxBlocks: -1 }));
  expect(loadConfig(PLAN, path)).toEqual(PLAN_DEFAULTS);
});

test("[git] loadConfig rejects an invalid mode and drops keys the spec no longer knows", () => {
  const path = tmp("git");
  // `worktrees` was a real field until the capability it configured turned out to be
  // unreachable code. A stale key left in a user's file must be ignored, not carried
  // through — `parse` builds the result from the fields it knows, never by spreading raw.
  writeFileSync(path, JSON.stringify({ mode: "nope", worktrees: { auto: true } }));
  expect(loadConfig(GIT, path)).toEqual(GIT_DEFAULTS);
});

test("[spawn] loadConfig floors a fractional concurrency and rejects non-string/sub-1 values", () => {
  const path = tmp("spawn");
  writeFileSync(path, JSON.stringify({ concurrency: 3.9, defaultModel: 5 }));
  expect(loadConfig(SPAWN, path)).toEqual({ defaultModel: "", concurrency: 3, jobTimeoutMs: SPAWN.defaults.jobTimeoutMs });
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
    ["browser", "git", "lens", "memory", "plan", "spawn"],
  );
});

test("[spawn] a non-positive jobTimeoutMs falls back to the default", () => {
  const path = tmp("spawn");
  writeFileSync(path, JSON.stringify({ jobTimeoutMs: 0 }));
  expect(loadConfig(SPAWN, path).jobTimeoutMs).toBe(SPAWN.defaults.jobTimeoutMs);
});

test("[lens] a non-positive verifyTimeoutMs falls back to the default", () => {
  const path = tmp("lens");
  writeFileSync(path, JSON.stringify({ verifyTimeoutMs: -1 }));
  expect(loadConfig(LENS, path).verifyTimeoutMs).toBe(LENS.defaults.verifyTimeoutMs);
});

test("[git] loadConfig rejects a zero or negative checkpoint TTL and size cap", () => {
  const path = tmp("git");
  writeFileSync(path, JSON.stringify({ checkpointTtlDays: 0, maxFileBytes: -1, detectDirty: "yes" }));
  expect(loadConfig(GIT, path)).toEqual(GIT_DEFAULTS);
});

// ---------------------------------------------------------------------------
// Non-finite numbers. Before `shared/fields.ts`, only pi-git rejected these: the
// other three numeric fields tested `value > 0`, and `Infinity > 0` is true. A
// config of `{"verifyTimeoutMs": 1e999}` therefore parsed to `Infinity` and removed
// pi-lens's verify deadline entirely — a timeout of Infinity is not a long timeout.
// JSON has no Infinity literal, but `1e999` overflows to it on parse, so this is
// reachable from a hand-edited file.
// ---------------------------------------------------------------------------

test("[lens] an overflowing verifyTimeoutMs falls back to the default rather than becoming Infinity", () => {
  const path = tmp("lens");
  writeFileSync(path, '{"verifyTimeoutMs": 1e999}');
  expect(loadConfig(LENS, path).verifyTimeoutMs).toBe(LENS.defaults.verifyTimeoutMs);
});

test("[spawn] an overflowing jobTimeoutMs falls back to the default", () => {
  const path = tmp("spawn");
  writeFileSync(path, '{"jobTimeoutMs": 1e999}');
  expect(loadConfig(SPAWN, path).jobTimeoutMs).toBe(SPAWN.defaults.jobTimeoutMs);
});

test("[spawn] an overflowing concurrency falls back rather than uncapping the pool", () => {
  const path = tmp("spawn");
  writeFileSync(path, '{"concurrency": 1e999}');
  expect(loadConfig(SPAWN, path).concurrency).toBe(SPAWN.defaults.concurrency);
});

test("[memory] an overflowing recallLimit falls back to the default", () => {
  const path = tmp("memory");
  writeFileSync(path, '{"recallLimit": 1e999}');
  expect(loadConfig(MEMORY, path).recallLimit).toBe(MEMORY.defaults.recallLimit);
});

test("[git] an overflowing maxFileBytes falls back, keeping the size cap meaningful", () => {
  const path = tmp("git");
  writeFileSync(path, '{"maxFileBytes": 1e999}');
  expect(loadConfig(GIT, path).maxFileBytes).toBe(GIT.defaults.maxFileBytes);
});
