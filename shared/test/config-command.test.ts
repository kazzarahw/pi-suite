import { test, expect } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  boolField,
  defineConfigCommand,
  displayValue,
  enumField,
  intField,
  parseValue,
  stringField,
  type Field,
} from "../config-command.ts";

/**
 * The engine behind all seven `/pi-<name>` commands.
 *
 * This file is the reason the seven per-extension command tests are thin: everything
 * shared is exercised here once, against a config shape chosen to include every field
 * kind and both display-placeholder behaviours. Before the collapse this logic existed
 * as seven closures at 14–28% line coverage, and each would have needed its own copy of
 * every case below.
 */

interface Cfg {
  mode: string;
  detect: boolean;
  count: number;
  cmd: string;
  session?: string;
}

const DEFAULTS: Cfg = { mode: "notify", detect: true, count: 3, cmd: "", session: "work" };

const FIELDS: readonly Field<Cfg>[] = [
  enumField("mode", ["off", "notify", "block"], "Mode"),
  boolField("detect", "Detect changes"),
  intField("count", "Count", { presets: [1, 2, 5] }),
  stringField("cmd", "Command", { presets: ["a", "b"], display: { placeholder: "(auto)" } }),
  // The other placeholder behaviour: clear the key rather than blanking it.
  stringField("session", "Session", {
    display: { placeholder: "(default)", storedWhenPlaceholder: undefined },
  }),
];

interface Harness {
  command: ReturnType<typeof defineConfigCommand<Cfg>>;
  saved: Cfg[];
  notices: Array<{ msg: string; level: string }>;
  ctx(mode?: string): ExtensionCommandContext;
  /** The last persisted config, or the starting one when nothing was written. */
  latest(): Cfg;
}

function harness(start: Cfg = DEFAULTS, opts = {}): Harness {
  const saved: Cfg[] = [];
  const notices: Array<{ msg: string; level: string }> = [];
  let current = { ...start };
  const command = defineConfigCommand<Cfg>(
    "demo",
    FIELDS,
    {
      loadConfig: () => current,
      saveConfig: (c) => {
        current = c;
        saved.push(c);
      },
    },
    opts,
  );
  return {
    command,
    saved,
    notices,
    ctx: (mode = "tui") =>
      ({
        mode,
        ui: {
          notify: (msg: string, level: string) => notices.push({ msg, level }),
          custom: async () => undefined,
        },
        sessionManager: { getCwd: () => "/tmp" },
      }) as unknown as ExtensionCommandContext,
    latest: () => current,
  };
}

// ---------------------------------------------------------------------------
// parseValue — pure, and the whole of the validation surface.
// ---------------------------------------------------------------------------

test("parseValue accepts a declared enum member and rejects anything else", () => {
  const mode = FIELDS[0]!;
  expect(parseValue(mode, "block")).toEqual({ value: "block" });
  const bad = parseValue(mode, "bogus");
  expect("error" in bad && bad.error).toContain("off, notify, block");
});

test("parseValue accepts every spelling of a boolean, in both directions", () => {
  const detect = FIELDS[1]!;
  for (const yes of ["on", "true", "yes"]) expect(parseValue(detect, yes)).toEqual({ value: true });
  for (const no of ["off", "false", "no"]) expect(parseValue(detect, no)).toEqual({ value: false });
  expect("error" in parseValue(detect, "maybe")).toBe(true);
});

test("parseValue rejects a non-integer, a fraction, and a sub-minimum count", () => {
  const count = FIELDS[2]!;
  expect(parseValue(count, "5")).toEqual({ value: 5 });
  for (const bad of ["abc", "2.5", "0", "-1", ""]) expect("error" in parseValue(count, bad)).toBe(true);
});

test("parseValue takes a string field verbatim, spaces and all", () => {
  expect(parseValue(FIELDS[3]!, "npm  run   test")).toEqual({ value: "npm  run   test" });
});

test("parseValue maps a placeholder back to its stored form, both kinds", () => {
  // "(auto)" has no storedWhenPlaceholder, so it stores "".
  expect(parseValue(FIELDS[3]!, "(auto)")).toEqual({ value: "" });
  // "(default)" declares `undefined`, meaning remove the key. `undefined ?? ""` would
  // collapse that to an empty string — a real bug this pins.
  expect(parseValue(FIELDS[4]!, "(default)")).toEqual({ value: undefined });
});

// ---------------------------------------------------------------------------
// displayValue — what a user sees for a stored value.
// ---------------------------------------------------------------------------

test("displayValue substitutes the placeholder for a blank or missing value", () => {
  expect(displayValue(FIELDS[3]!, { ...DEFAULTS, cmd: "" })).toBe("(auto)");
  expect(displayValue(FIELDS[4]!, { ...DEFAULTS, session: undefined })).toBe("(default)");
  expect(displayValue(FIELDS[3]!, { ...DEFAULTS, cmd: "bun test" })).toBe("bun test");
});

test("displayValue renders booleans as on/off and numbers as digits", () => {
  expect(displayValue(FIELDS[1]!, { ...DEFAULTS, detect: true })).toBe("on");
  expect(displayValue(FIELDS[1]!, { ...DEFAULTS, detect: false })).toBe("off");
  expect(displayValue(FIELDS[2]!, { ...DEFAULTS, count: 7 })).toBe("7");
});

// ---------------------------------------------------------------------------
// The argument form.
// ---------------------------------------------------------------------------

test("a verb and value persist the field", async () => {
  const h = harness();
  await h.command.options.handler("mode block", h.ctx());
  expect(h.latest().mode).toBe("block");
});

test("an invalid value persists nothing and reports why", async () => {
  const h = harness();
  await h.command.options.handler("mode bogus", h.ctx());
  expect(h.saved).toEqual([]);
  expect(h.notices[0]!.level).toBe("error");
  expect(h.notices[0]!.msg).toContain("[pi-demo]");
});

test("an unknown verb persists nothing and lists the real ones", async () => {
  const h = harness();
  await h.command.options.handler("nonsense value", h.ctx());
  expect(h.saved).toEqual([]);
  expect(h.notices[0]!.msg).toContain("unknown option");
  expect(h.notices[0]!.msg).toContain("mode <off|notify|block>");
});

test("only the first space splits verb from value, so a value keeps its spacing", () => {
  // Three of the seven commands split on all whitespace and rejoined, which silently
  // collapsed runs of spaces inside a value.
  const h = harness();
  return h.command.options.handler("cmd npm  run   test", h.ctx()).then(() => {
    expect(h.latest().cmd).toBe("npm  run   test");
  });
});

test("a placeholder given as an argument stores the underlying value", async () => {
  const h = harness({ ...DEFAULTS, cmd: "bun test" });
  await h.command.options.handler("cmd (auto)", h.ctx());
  expect(h.latest().cmd).toBe("");
});

test("a placeholder declaring undefined removes the key rather than blanking it", async () => {
  const h = harness();
  await h.command.options.handler("session (default)", h.ctx());
  expect("session" in h.latest() && h.latest().session !== undefined).toBe(false);
});

test("every write re-reads the config, so one toggle never reverts an earlier one", async () => {
  const h = harness();
  await h.command.options.handler("mode block", h.ctx());
  await h.command.options.handler("count 5", h.ctx());
  // The second write must build on the first, not on the snapshot taken at build time.
  expect(h.latest()).toMatchObject({ mode: "block", count: 5 });
});

// ---------------------------------------------------------------------------
// The bare-value form.
// ---------------------------------------------------------------------------

test("a bare value sets the designated field", async () => {
  const h = harness(DEFAULTS, { bareValueField: "mode" });
  await h.command.options.handler("block", h.ctx());
  expect(h.latest().mode).toBe("block");
});

test("a bare value that is not valid for the field is refused, not stored", async () => {
  const h = harness(DEFAULTS, { bareValueField: "mode" });
  await h.command.options.handler("bogus", h.ctx());
  expect(h.saved).toEqual([]);
});

test("without a bare-value field, a lone word is an unknown option", async () => {
  const h = harness();
  await h.command.options.handler("block", h.ctx());
  expect(h.saved).toEqual([]);
  expect(h.notices[0]!.msg).toContain("unknown option");
});

// ---------------------------------------------------------------------------
// Completions.
// ---------------------------------------------------------------------------

test("completions offer the verbs, filtered by prefix", () => {
  const h = harness();
  const items = h.command.options.getArgumentCompletions("c") ?? [];
  expect(items.map((i) => i.value).sort()).toEqual(["cmd", "count"]);
});

test("completions return null rather than an empty list when nothing matches", () => {
  // Pi treats null as "no completions"; an empty array renders an empty popup.
  expect(harness().command.options.getArgumentCompletions("zzz")).toBeNull();
});

test("a bare-value enum command also completes its values", () => {
  const h = harness(DEFAULTS, { bareValueField: "mode" });
  const items = h.command.options.getArgumentCompletions("b") ?? [];
  expect(items.map((i) => i.value)).toContain("block");
});

test("a bare-value string command completes its presets", () => {
  // This is how /pi-consult offers its allowedModels; it regressed once when only enum
  // fields were considered.
  const h = harness(DEFAULTS, { bareValueField: "cmd" });
  const items = h.command.options.getArgumentCompletions("a") ?? [];
  expect(items.map((i) => i.value)).toContain("a");
});

test("presets given as a thunk are read per call, not captured once", () => {
  let models = ["opus"];
  const command = defineConfigCommand<Cfg>(
    "demo",
    [stringField("cmd", "Command", { presets: () => models })],
    { loadConfig: () => DEFAULTS, saveConfig: () => {} },
    { bareValueField: "cmd" },
  );
  expect((command.options.getArgumentCompletions("s") ?? []).map((i) => i.value)).toEqual([]);
  models = ["opus", "sonnet"];
  expect((command.options.getArgumentCompletions("s") ?? []).map((i) => i.value)).toEqual(["sonnet"]);
});

// ---------------------------------------------------------------------------
// The no-TUI readout and the settings panel.
// ---------------------------------------------------------------------------

test("with no TUI the handler prints a readout and opens nothing", async () => {
  const h = harness();
  await h.command.options.handler("", h.ctx("print"));
  expect(h.notices[0]!.msg).toContain("mode: notify");
  expect(h.notices[0]!.msg).toContain("detect: on");
  expect(h.saved).toEqual([]);
});

test("readoutExtra is appended to the no-TUI readout", async () => {
  const h = harness(DEFAULTS, { readoutExtra: () => "agents: alpha, beta" });
  await h.command.options.handler("", h.ctx("print"));
  expect(h.notices.map((n) => n.msg).join("\n")).toContain("agents: alpha, beta");
});

test("a blank readoutExtra adds no second notice", async () => {
  const h = harness(DEFAULTS, { readoutExtra: () => undefined });
  await h.command.options.handler("", h.ctx("print"));
  expect(h.notices).toHaveLength(1);
});

test("in TUI mode the handler opens the panel instead of printing", async () => {
  let opened = 0;
  const h = harness();
  const ctx = {
    mode: "tui",
    ui: {
      notify: () => {},
      custom: async () => {
        opened += 1;
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;
  await h.command.options.handler("", ctx);
  expect(opened).toBe(1);
});

// ---------------------------------------------------------------------------
// Extra verbs — the escape hatch for actions that are not fields.
// ---------------------------------------------------------------------------

test("an extra verb receives its value and the prefixed notifier", async () => {
  const seen: string[] = [];
  const h = harness(DEFAULTS, {
    extraVerbs: [
      {
        verb: "delete",
        usage: "delete <name>",
        handle: (value: string, _ctx: unknown, notify: { info(m: string): void }) => {
          seen.push(value);
          notify.info(`deleted "${value}"`);
        },
      },
    ],
  });
  await h.command.options.handler("delete my-note", h.ctx());
  expect(seen).toEqual(["my-note"]);
  expect(h.notices[0]!.msg).toBe('[pi-demo] deleted "my-note"');
  expect(h.saved).toEqual([]); // an action, not a setting
});

test("an extra verb appears in completions and in the unknown-option hint", async () => {
  const h = harness(DEFAULTS, {
    extraVerbs: [{ verb: "delete", usage: "delete <name>", handle: () => {} }],
  });
  expect((h.command.options.getArgumentCompletions("d") ?? []).map((i) => i.value)).toContain("delete");
  await h.command.options.handler("bogus x", h.ctx());
  expect(h.notices[0]!.msg).toContain("delete <name>");
});

test("an async extra verb is awaited before the handler returns", async () => {
  let done = false;
  const h = harness(DEFAULTS, {
    extraVerbs: [
      {
        verb: "slow",
        usage: "slow",
        handle: async () => {
          await new Promise((r) => setTimeout(r, 5));
          done = true;
        },
      },
    ],
  });
  await h.command.options.handler("slow", h.ctx());
  expect(done).toBe(true);
});

// ---------------------------------------------------------------------------
// Generated description.
// ---------------------------------------------------------------------------

test("the generated description names every verb", () => {
  const h = harness();
  const d = h.command.options.description;
  expect(d).toContain("mode <off|notify|block>");
  expect(d).toContain("detect on|off");
  expect(d).toContain("count <value>");
});

test("an explicit description overrides the generated one", () => {
  const h = harness(DEFAULTS, { description: "custom text" });
  expect(h.command.options.description).toBe("custom text");
});

test("the command is named pi-<name>", () => {
  expect(harness().command.name).toBe("pi-demo");
});
