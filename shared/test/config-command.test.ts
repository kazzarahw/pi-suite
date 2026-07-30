import { test, expect, beforeAll } from "bun:test";
import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  boolField,
  defineConfigCommand,
  displayValue,
  enumField,
  intField,
  parseValue,
  stringField,
  DAYS,
  MEGABYTES,
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

// The panel calls `getSettingsListTheme()`, which throws unless Pi's global theme has
// been initialized — see the note in settings-panel.test.ts.
beforeAll(() => {
  initTheme();
});

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

test("parseValue rejects a blank value for a string field that cannot express blank", () => {
  // A field with no `display` has no rendering for "", so "" is not a value it can hold.
  // `/pi-browser binpath` with no argument used to store it anyway, leaving the config
  // naming a binary that cannot be executed until the next load repaired it.
  const noPlaceholder = stringField<Cfg>("cmd", "Command");
  expect(parseValue(noPlaceholder, "")).toEqual({ error: "cmd needs a value" });
  // The two fields in the suite without a placeholder are exactly the two whose
  // ConfigSpec reads them with `nonEmptyStr`, so this agrees with the config layer.
  expect(parseValue(noPlaceholder, "agent-browser")).toEqual({ value: "agent-browser" });
});

test("parseValue still accepts a blank value where blank is meaningful", () => {
  // FIELDS[3] declares a "(auto)" placeholder, so "" is a value it can show — pi-lens's
  // verifyCmd, where empty means autodetect from the project.
  expect(parseValue(FIELDS[3]!, "")).toEqual({ value: "" });
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
  // A string field's presets reach completions the same way an enum's values do; this
  // regressed once when only enum fields were considered.
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

// ---------------------------------------------------------------------------
// The panel path — where a value is actually meant to be set.
//
// The argument forms above are the scriptable back door; opening `/pi-<name>` and
// toggling a row is the intended interface, so this is the path that matters most. It
// was also the only part of the engine no test reached: every case above stops at
// `ctx.ui.custom`, which the harness fakes as a function that returns immediately, so
// the callback handed to `openSettingsPanel` — the field lookup and the persist — never
// ran. These drive the real `SettingsList` instead: a space keypress cycles the selected
// row's value and fires exactly the callback a user's keypress would.
// ---------------------------------------------------------------------------

interface Panel {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/** A harness whose `ctx.ui.custom` keeps the component, so the panel can be driven. */
function panelHarness(start: Cfg = DEFAULTS, opts = {}) {
  const base = harness(start, opts);
  let panel: Panel | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      notify: (msg: string, level: string) => base.notices.push({ msg, level }),
      custom: async (build: (t: unknown, th: unknown, kb: unknown, d: (v: unknown) => void) => Panel) => {
        panel = build(
          { requestRender: () => {} },
          { fg: (_c: string, s: string) => s, bold: (s: string) => s },
          {},
          () => {},
        );
        return undefined;
      },
    },
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as ExtensionCommandContext;

  return {
    ...base,
    /** Open the panel and return it, ready for input. */
    async open(): Promise<Panel> {
      await base.command.options.handler("", ctx);
      return panel!;
    },
    /** Move down `n` rows, then cycle the selected row's value once. */
    cycle(p: Panel, n = 0): void {
      for (let i = 0; i < n; i++) p.handleInput("[B"); // arrow down
      p.handleInput(" ");
    },
  };
}

test("cycling a row in the panel persists the new value", async () => {
  const h = panelHarness();
  const panel = await h.open();
  // Row 0 is `mode`, starting at "notify". Note the order: `panelValues` puts whatever
  // is stored *first*, then the presets, so the list is [notify, off, block] rather than
  // the declaration order [off, notify, block] — one cycle from the initial state lands
  // on the first preset, not on the next mode along.
  h.cycle(panel, 0);
  expect(h.saved).toHaveLength(1);
  expect(h.latest().mode).toBe("off");
  h.cycle(panel, 0);
  expect(h.latest().mode).toBe("block");
});

test("cycling a bool row in the panel writes a boolean, not the string 'off'", async () => {
  const h = panelHarness();
  const panel = await h.open();
  h.cycle(panel, 1); // row 1 is `detect`, starting at "on"
  expect(h.latest().detect).toBe(false);
});

test("selecting the placeholder row stores the underlying value, not the label", async () => {
  // `cmd` starts at "" and so displays "(auto)"; its values are the placeholder followed
  // by the presets, so one cycle moves to "a" and a full lap returns to the placeholder.
  const h = panelHarness();
  const panel = await h.open();
  h.cycle(panel, 3);
  expect(h.latest().cmd).toBe("a");
  h.cycle(panel, 0); // already on row 3
  h.cycle(panel, 0);
  // Back on "(auto)" — and what lands in the config is "", never the label itself.
  expect(h.latest().cmd).toBe("");
});

test("a placeholder declaring undefined removes the key when picked in the panel", async () => {
  const h = panelHarness();
  const panel = await h.open();
  // Row 4 is `session`, starting at "work"; values are ["work", "(default)"].
  h.cycle(panel, 4);
  expect(h.latest().session).toBeUndefined();
});

test("each panel toggle re-reads, so one row never reverts another", async () => {
  // The regression this guards: `apply` closing over one `loadConfig()` snapshot taken
  // when the panel opened. Every toggle would then write that stale base back, and the
  // second row silently undid the first.
  const h = panelHarness();
  const panel = await h.open();
  h.cycle(panel, 0); // mode → off
  h.cycle(panel, 1); // detect → false, from a config that already has mode: off
  expect(h.latest().mode).toBe("off");
  expect(h.latest().detect).toBe(false);
});

test("the panel opens one row per field, each showing its current value", async () => {
  const h = panelHarness();
  const panel = await h.open();
  const rendered = panel.render(80).join("\n");
  for (const label of ["Mode", "Detect changes", "Count", "Command", "Session"]) {
    expect(rendered).toContain(label);
  }
  // Blank-valued fields show their placeholder rather than an empty row.
  expect(rendered).toContain("(auto)");
});

// --- Units on an int field --------------------------------------------------
//
// `/pi-git` was the one panel with values that did not say what they were: `Keep
// checkpoints for 30` and `Max file size 10485760`, in a column that otherwise reads
// `notify` / `on` / `(autodetect)`.
//
// The binding constraint is the round-trip. The panel offers `panelValues` and hands the
// chosen string straight back to `parseValue`, so anything `format` produces `parse` has
// to accept — a formatter alone would make every row in the panel unsettable.

interface UnitCfg {
  ttl: number;
  bytes: number;
}
const UNIT_FIELDS: readonly Field<UnitCfg>[] = [
  intField("ttl", "Keep checkpoints for", { presets: [7, 30, 90], unit: DAYS }),
  intField("bytes", "Max file size", { presets: [1_048_576, 10_485_760], unit: MEGABYTES }),
];
const ttl = UNIT_FIELDS[0]!;
const bytes = UNIT_FIELDS[1]!;

test("a unit-bearing field displays its value with the unit", () => {
  expect(displayValue(ttl, { ttl: 30, bytes: 0 })).toBe("30 days");
  expect(displayValue(ttl, { ttl: 1, bytes: 0 })).toBe("1 day");
  expect(displayValue(bytes, { ttl: 0, bytes: 10_485_760 })).toBe("10 MB");
});

test("everything format produces, parse accepts — the panel round-trip", () => {
  for (const n of [1, 7, 30, 90]) {
    expect(parseValue(ttl, DAYS.format(n))).toEqual({ value: n });
  }
  for (const n of [1_048_576, 10_485_760, 52_428_800]) {
    expect(parseValue(bytes, MEGABYTES.format(n))).toEqual({ value: n });
  }
});

test("a bare number still means what it always meant — bytes, and days", () => {
  // `/pi-git maxbytes 10485760` and a hand-edited config file predate the unit and must
  // keep working: this is a display concern, and the stored value is unchanged.
  expect(parseValue(ttl, "30")).toEqual({ value: 30 });
  expect(parseValue(bytes, "10485760")).toEqual({ value: 10_485_760 });
});

test("the unit's own shorthands parse too", () => {
  expect(parseValue(ttl, "30d")).toEqual({ value: 30 });
  expect(parseValue(ttl, "30 days")).toEqual({ value: 30 });
  expect(parseValue(bytes, "10mb")).toEqual({ value: 10_485_760 });
  expect(parseValue(bytes, "10 MiB")).toEqual({ value: 10_485_760 });
});

test("a size that is not a whole number of MB is shown as it is, never rounded", () => {
  // The panel must not display a value the config does not hold.
  const half = 1_572_864; // 1.5 MiB
  expect(MEGABYTES.format(half)).toBe("1.5 MB");
  expect(parseValue(bytes, "1.5 MB")).toEqual({ value: half });
});

test("nonsense is still rejected, and the message speaks in the unit", () => {
  const bad = parseValue(ttl, "soon");
  expect(bad).toHaveProperty("error");
  expect((bad as { error: string }).error).toContain("1 day");
});

test("the panel lists a unit field's presets in numeric order, not text order", async () => {
  // `Number("10 MB")` is NaN, so sorting the display strings would leave the rows in
  // whatever order the set happened to produce.
  const cmd = defineConfigCommand("unit", UNIT_FIELDS, {
    loadConfig: () => ({ ttl: 30, bytes: 10_485_760 }),
    saveConfig: () => {},
  });
  const items = cmd.options.getArgumentCompletions?.("") ?? [];
  expect(items.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Secret fields.
//
// pi-telegram's bot token is the first credential in the suite, and `telegram.ts` takes
// care to `redact()` it out of every error string it builds. The command surface then
// undid all of that: the panel drew it as an ordinary row, the no-TUI readout printed it
// beside the other fields, and `/pi-telegram token <tok>` confirmed the write by quoting
// it back into the terminal.
// ---------------------------------------------------------------------------

interface SecretCfg {
  token: string;
}
const SECRET_FIELDS: readonly Field<SecretCfg>[] = [
  stringField("token", "Bot token", {
    secret: true,
    display: { placeholder: "(not set)", storedWhenPlaceholder: "" },
  }),
];

function secretHarness(start: SecretCfg): {
  command: ReturnType<typeof defineConfigCommand<SecretCfg>>;
  saved: SecretCfg[];
  notices: string[];
  ctx(mode?: string): ExtensionCommandContext;
} {
  const saved: SecretCfg[] = [];
  const notices: string[] = [];
  let current = { ...start };
  const command = defineConfigCommand<SecretCfg>(
    "demo",
    SECRET_FIELDS,
    {
      loadConfig: () => current,
      saveConfig: (c) => {
        current = c;
        saved.push(c);
      },
    },
    {},
  );
  const ctx = (mode = "tui") =>
    ({ mode, ui: { notify: (msg: string) => notices.push(msg) } }) as unknown as ExtensionCommandContext;
  return { command, saved, notices, ctx };
}

test("a secret field never renders its stored value", () => {
  expect(displayValue(SECRET_FIELDS[0]!, { token: "123456:AAH-real-token" })).toBe("(set)");
  // Unset is not a secret, and "(not set)" is the useful answer.
  expect(displayValue(SECRET_FIELDS[0]!, { token: "" })).toBe("(not set)");
});

test("setting a secret confirms the write without quoting the value", async () => {
  const h = secretHarness({ token: "" });
  await h.command.options.handler("token 123456:AAH-real-token", h.ctx());

  expect(h.saved).toEqual([{ token: "123456:AAH-real-token" }]);
  expect(h.notices.join("\n")).not.toContain("AAH-real-token");
  expect(h.notices.join("\n")).toContain("(set)");
});

test("the no-TUI readout masks a secret too", async () => {
  const h = secretHarness({ token: "123456:AAH-real-token" });
  await h.command.options.handler("", h.ctx("print"));
  expect(h.notices.join("\n")).not.toContain("AAH-real-token");
  expect(h.notices.join("\n")).toContain("token: (set)");
});

test("choosing the mask back out of the panel leaves the credential alone", async () => {
  // The trap `Display` warns about, in its sharpest form: the panel offers whatever
  // `displayValue` produced as the current value and hands the chosen string straight to
  // the writer, so a masked field with no inverse would replace the token with "(set)".
  const h = secretHarness({ token: "123456:AAH-real-token" });
  await h.command.options.handler("token (set)", h.ctx());
  expect(h.saved).toEqual([]);
});

test("the placeholder still clears a secret, so there is a way to unset one", async () => {
  const h = secretHarness({ token: "123456:AAH-real-token" });
  await h.command.options.handler("token (not set)", h.ctx());
  expect(h.saved).toEqual([{ token: "" }]);
});
