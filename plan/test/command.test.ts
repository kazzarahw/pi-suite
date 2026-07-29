import { test, expect } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildPlanCommand, FIELDS } from "../src/command.ts";
import { DEFAULTS, type PlanConfig } from "../src/config.ts";
import {
  applyDrop,
  applyItems,
  applyObjective,
  emptyPlan,
  type Plan,
} from "../src/state.ts";

function harness(plan: Plan = emptyPlan(), cfg: PlanConfig = DEFAULTS) {
  let config = { ...cfg };
  let current = plan;
  const cleared: string[] = [];
  const reset: string[] = [];
  const command = buildPlanCommand({
    loadConfig: () => config,
    saveConfig: (c) => {
      config = c;
    },
    getPlan: () => current,
    clearPlan: () => {
      cleared.push("clear");
      current = { objective: null, items: [], log: current.log, seq: current.seq };
    },
    resetPlan: () => {
      reset.push("reset");
      current = emptyPlan();
    },
  });

  const notices: string[] = [];
  let opened = 0;
  const ctx = (mode = "print") =>
    ({
      mode,
      ui: {
        notify: (msg: string) => notices.push(msg),
        custom: async () => {
          opened += 1;
          return undefined;
        },
      },
      sessionManager: { getCwd: () => process.cwd() },
    }) as unknown as ExtensionCommandContext;

  return {
    run: (args: string, mode = "print") => command.options.handler(args, ctx(mode)),
    notices,
    opened: () => opened,
    config: () => config,
    plan: () => current,
    cleared,
    reset,
    command,
  };
}

const said = (h: ReturnType<typeof harness>) => h.notices.join("\n");

test("the command is named for the extension and covers every config key", () => {
  const h = harness();
  expect(h.command.name).toBe("pi-plan");
  // A key with no field is a setting with no way to reach it — checked repo-wide in
  // test/commands.test.ts, and pinned here as the table's own property.
  expect(FIELDS.map((f) => f.key).sort()).toEqual(["maxBlocks", "maxNudges", "mode"]);
});

test("a bare mode word sets the mode, and a bad one is refused", async () => {
  const h = harness();
  await h.run("block");
  expect(h.config().mode).toBe("block");
  await h.run("not-a-mode");
  expect(said(h)).toContain("invalid mode");
});

test("the numeric fields are reachable by their own verbs", async () => {
  const h = harness();
  await h.run("nudges 5");
  await h.run("blocks 1");
  expect(h.config().maxNudges).toBe(5);
  expect(h.config().maxBlocks).toBe(1);
});

test("a sub-1 quota is refused rather than silently disarming a bound", async () => {
  const h = harness();
  await h.run("blocks 0");
  expect(said(h)).toContain("must be an integer");
  expect(h.config().maxBlocks).toBe(DEFAULTS.maxBlocks);
});

test("with no TUI it prints a readout naming the plan, and in TUI it opens the panel", async () => {
  const h = harness(applyObjective(emptyPlan(), { objective: "merge todo and goal" }).plan);
  await h.run("");
  expect(said(h)).toContain("[pi-plan]");
  expect(said(h)).toContain("merge todo and goal");
  expect(h.opened()).toBe(0);

  await h.run("", "tui");
  expect(h.opened()).toBe(1);
});

test("the readout describes an unplanned session honestly", async () => {
  const h = harness();
  await h.run("");
  expect(said(h)).toContain("no plan set");

  const listed = harness(applyItems(emptyPlan(), [{ content: "a" }]).plan);
  await listed.run("");
  expect(said(listed)).toContain("1 open item(s), no objective");
});

// ---------------------------------------------------------------------------
// clear and reset — the two verbs, and why they are two.
// ---------------------------------------------------------------------------

test("clear forgets the plan and says how much of the log it kept", async () => {
  const dropped = applyDrop(applyItems(emptyPlan(), [{ content: "a" }]).plan, "1", "no").plan;
  const h = harness(applyObjective(dropped, { objective: "ship it" }).plan);
  await h.run("clear");
  expect(h.cleared).toEqual(["clear"]);
  // Said out loud, because a user who wanted everything gone needs to know it is not.
  expect(said(h)).toContain("1 log entry kept");
  expect(said(h)).toContain("reset");
});

test("clear on a plan with no log does not mention one", async () => {
  const h = harness(applyObjective(emptyPlan(), { objective: "ship it" }).plan);
  await h.run("clear");
  expect(said(h)).toContain("plan cleared");
  expect(said(h)).not.toContain("log entr");
});

test("clear with nothing to clear says so rather than recording a no-op", async () => {
  const h = harness();
  await h.run("clear");
  expect(said(h)).toContain("nothing to clear");
  expect(h.cleared).toEqual([]);
});

test("reset forgets everything, log included, and says so", async () => {
  const dropped = applyDrop(applyItems(emptyPlan(), [{ content: "a" }]).plan, "1", "no").plan;
  const h = harness(dropped);
  await h.run("reset");
  expect(h.reset).toEqual(["reset"]);
  expect(h.plan().log).toEqual([]);
  expect(said(h)).toContain("log all forgotten");
});

test("setting the objective is deliberately not a verb — that is the agent's job", async () => {
  const h = harness();
  await h.run("objective ship it");
  // Read as a bare mode value, which it is not, rather than quietly authoring a plan.
  expect(said(h)).toContain("invalid mode");
  expect(h.plan().objective).toBeNull();
});

test("completions offer the verbs and the bare mode values", async () => {
  const h = harness();
  const items = h.command.options.getArgumentCompletions("") as Array<{ value: string }> | null;
  const values = (items ?? []).map((i) => i.value);
  for (const expected of ["mode", "nudges", "blocks", "clear", "reset", "off", "notify", "block"]) {
    expect(values).toContain(expected);
  }
});
