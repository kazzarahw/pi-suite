import { test, expect } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildGoalCommand, FIELDS } from "../src/command.ts";
import { DEFAULTS, type GoalConfig } from "../src/config.ts";
import type { Goal } from "../src/state.ts";

/**
 * The engine behind this command is covered once, in shared/test/config-command.test.ts.
 * What is left here is pi-goal's own declaration: the `clear` verb, and the live state
 * the subtitle and readout report.
 */
function harness(goal: Goal | null = null) {
  let cfg: GoalConfig = { ...DEFAULTS };
  let current = goal;
  const cleared: number[] = [];
  const notices: string[] = [];
  const command = buildGoalCommand({
    loadConfig: () => cfg,
    saveConfig: (c) => {
      cfg = c;
    },
    getGoal: () => current,
    clearGoal: () => {
      current = null;
      cleared.push(1);
    },
  });
  const ctx = (mode: string) =>
    ({
      mode,
      ui: { notify: (msg: string) => notices.push(msg) },
      sessionManager: { getCwd: () => process.cwd() },
    }) as unknown as ExtensionCommandContext;
  return { command, ctx, notices, cleared, config: () => cfg, current: () => current };
}

test("both config keys are reachable as fields", () => {
  expect(FIELDS.map((f) => f.key).sort()).toEqual(["maxNudges", "mode"]);
});

test("/pi-goal clear forgets the objective", async () => {
  const h = harness({ objective: "ship it", status: "active" });
  await h.command.options.handler("clear", h.ctx("print"));
  expect(h.cleared).toHaveLength(1);
  expect(h.current()).toBeNull();
  expect(h.notices.join("\n")).toContain("objective cleared");
});

test("/pi-goal clear says so when there is nothing to clear", async () => {
  const h = harness(null);
  await h.command.options.handler("clear", h.ctx("print"));
  expect(h.cleared).toHaveLength(0);
  expect(h.notices.join("\n")).toContain("no objective set");
});

test("the readout reports the live objective, which no field holds", async () => {
  const h = harness({ objective: "ship the auth refactor", status: "active" });
  await h.command.options.handler("", h.ctx("print"));
  const said = h.notices.join("\n");
  expect(said).toContain("mode: notify");
  expect(said).toContain("nudges: 2");
  expect(said).toContain("active: ship the auth refactor");
});

test("a lone word is read as the mode", async () => {
  const h = harness();
  await h.command.options.handler("block", h.ctx("print"));
  expect(h.config().mode).toBe("block");
});

test("the nudge quota is settable by verb", async () => {
  const h = harness();
  await h.command.options.handler("nudges 5", h.ctx("print"));
  expect(h.config().maxNudges).toBe(5);
});

test("clear completes as a verb", () => {
  const h = harness();
  const items = h.command.options.getArgumentCompletions("cl") as Array<{ value: string }> | null;
  expect(items?.map((i) => i.value)).toEqual(["clear"]);
});

test("the command is named for the extension", () => {
  expect(harness().command.name).toBe("pi-goal");
});
