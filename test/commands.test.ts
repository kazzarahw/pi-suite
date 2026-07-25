import { test, expect } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadExtension } from "../shared/test/harness.ts";
import { SURFACE } from "../shared/index.ts";

import { FIELDS as GIT_FIELDS } from "../git/src/command.ts";
import { FIELDS as TODO_FIELDS } from "../todo/src/command.ts";
import { FIELDS as LENS_FIELDS } from "../lens/src/command.ts";
import { FIELDS as MEMORY_FIELDS } from "../memory/src/command.ts";
import { FIELDS as SPAWN_FIELDS } from "../spawn/src/command.ts";
import { FIELDS as BROWSER_FIELDS } from "../browser/src/command.ts";
import { fieldsFor as CONSULT_FIELDS } from "../consult/src/command.ts";

import { DEFAULTS as GIT_DEFAULTS } from "../git/src/config.ts";
import { DEFAULTS as TODO_DEFAULTS } from "../todo/src/config.ts";
import { DEFAULTS as LENS_DEFAULTS } from "../lens/src/config.ts";
import { DEFAULTS as MEMORY_DEFAULTS } from "../memory/src/config.ts";
import { DEFAULTS as SPAWN_DEFAULTS } from "../spawn/src/config.ts";
import { DEFAULTS as BROWSER_DEFAULTS } from "../browser/src/config.ts";
import { DEFAULTS as CONSULT_DEFAULTS } from "../consult/src/config.ts";

/**
 * The seven field tables, checked against the configs they claim to edit.
 *
 * The engine behind them is covered in `shared/test/config-command.test.ts`; what is
 * left per extension is whether its *declaration* is right. A field naming a key its
 * config does not have would type-check — `keyof T` is satisfied by any key that exists
 * — but a field silently *missing* would not, and a setting with no way to reach it is
 * exactly the kind of thing nobody notices.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the table is heterogeneous by design */
const TABLES: Array<{ dir: string; fields: ReadonlyArray<{ key: string }>; defaults: any }> = [
  { dir: "git", fields: GIT_FIELDS, defaults: GIT_DEFAULTS },
  { dir: "todo", fields: TODO_FIELDS, defaults: TODO_DEFAULTS },
  { dir: "lens", fields: LENS_FIELDS, defaults: LENS_DEFAULTS },
  { dir: "memory", fields: MEMORY_FIELDS, defaults: MEMORY_DEFAULTS },
  { dir: "spawn", fields: SPAWN_FIELDS, defaults: SPAWN_DEFAULTS },
  { dir: "browser", fields: BROWSER_FIELDS, defaults: BROWSER_DEFAULTS },
  {
    dir: "consult",
    fields: CONSULT_FIELDS({ loadConfig: () => CONSULT_DEFAULTS, saveConfig: () => {} }),
    defaults: CONSULT_DEFAULTS,
  },
];

// A field naming a key its config does not have is already impossible: `Field<T>` types
// `key` as `keyof T & string`, so the compiler rejects it. Only the reverse direction —
// a key with no field, which type-checks perfectly — needs a runtime check, below.

for (const { dir, fields } of TABLES) {
  test(`[${dir}] every field has a distinct key`, () => {
    const keys = fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
}

/**
 * Fields the panel deliberately does not expose.
 *
 * Not every config key belongs in the UI — some are escape valves for a JSON file rather
 * than knobs, and one is the *source* of another field's presets. Listing them here means
 * a key added later without a field shows up as a failure that has to be answered
 * deliberately, rather than quietly having no way to reach it.
 */
const INTENTIONALLY_UNEXPOSED: Record<string, string[]> = {
  // Bounded by the store and rarely tuned; editable in the JSON file.
  git: ["maxFileBytes"],
  // A deadline for a whole test suite — set once, in the file, if at all.
  lens: ["verifyTimeoutMs"],
  // Same, for a delegated job.
  spawn: ["jobTimeoutMs"],
  // The source of the `defaultModel` presets, not a field of its own.
  consult: ["allowedModels"],
};

for (const { dir, fields, defaults } of TABLES) {
  test(`[${dir}] every config key is either a field or listed as deliberately unexposed`, () => {
    const exposed = new Set(fields.map((f) => f.key));
    const allowed = new Set(INTENTIONALLY_UNEXPOSED[dir] ?? []);
    const unreachable = Object.keys(defaults).filter((k) => !exposed.has(k) && !allowed.has(k));
    expect(unreachable).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// Each registered command answers, in both UI modes, without touching the config.
// ---------------------------------------------------------------------------

function recordingCtx(mode: string) {
  const notices: string[] = [];
  let opened = 0;
  return {
    notices,
    opened: () => opened,
    ctx: {
      mode,
      ui: {
        notify: (msg: string) => notices.push(msg),
        custom: async () => {
          opened += 1;
          return undefined;
        },
      },
      sessionManager: { getCwd: () => process.cwd() },
    } as unknown as ExtensionCommandContext,
  };
}

for (const ext of SURFACE) {
  test(`[${ext.dir}] /${ext.command} prints a readout with no TUI`, async () => {
    const api = await loadExtension(ext.dir);
    const rec = recordingCtx("print");
    await api.commands.get(ext.command)!.handler("", rec.ctx);
    // Every command says *something*, prefixed with its own name — a command that
    // silently does nothing reads as broken.
    expect(rec.notices.length).toBeGreaterThan(0);
    expect(rec.notices[0]).toContain(`[${ext.command}]`);
  });

  test(`[${ext.dir}] /${ext.command} opens the panel in TUI mode`, async () => {
    const api = await loadExtension(ext.dir);
    const rec = recordingCtx("tui");
    await api.commands.get(ext.command)!.handler("", rec.ctx);
    expect(rec.opened()).toBe(1);
  });

  test(`[${ext.dir}] /${ext.command} answers an unrecognised argument rather than ignoring it`, async () => {
    const api = await loadExtension(ext.dir);
    const rec = recordingCtx("print");
    await api.commands.get(ext.command)!.handler("definitely-not-a-verb x", rec.ctx);
    // What it says depends on the command's shape — see the two tests below — but a
    // command that says nothing at all reads as broken.
    expect(rec.notices.length).toBeGreaterThan(0);
  });

  test(`[${ext.dir}] /${ext.command} offers completions`, async () => {
    const api = await loadExtension(ext.dir);
    // Four of the seven had no completions at all before the commands were unified.
    const items = api.commands.get(ext.command)!.getArgumentCompletions?.("") as unknown[] | null;
    expect(items?.length ?? 0).toBeGreaterThan(0);
  });
}

/**
 * A command with no bare-value field has no other reading for a lone word, so it says so.
 */
for (const dir of ["lens", "memory", "spawn", "browser"]) {
  const command = SURFACE.find((e) => e.dir === dir)!.command;
  test(`[${dir}] /${command} names an unknown verb as such`, async () => {
    const api = await loadExtension(dir);
    const rec = recordingCtx("print");
    await api.commands.get(command)!.handler("definitely-not-a-verb x", rec.ctx);
    expect(rec.notices.join("\n")).toContain("unknown option");
  });
}

/**
 * A command whose bare-value field is an enum reads a lone word as that field's value,
 * and rejects one that is not a member — `/pi-git notify` is the whole point of the form.
 */
for (const dir of ["git", "todo"]) {
  const command = SURFACE.find((e) => e.dir === dir)!.command;
  test(`[${dir}] /${command} reads a lone word as the mode and rejects a bad one`, async () => {
    const api = await loadExtension(dir);
    const rec = recordingCtx("print");
    await api.commands.get(command)!.handler("not-a-mode", rec.ctx);
    expect(rec.notices.join("\n")).toContain("invalid mode");
  });
}

/**
 * pi-consult's bare value is free text, because a model alias is not a closed set — the
 * configured `allowedModels` drive completions but were never enforced. Accepting an
 * unfamiliar name is the documented behaviour, not a missing check.
 */
test("[consult] /pi-consult accepts any lone word as a model name", async () => {
  const api = await loadExtension("consult");
  const rec = recordingCtx("print");
  await api.commands.get("pi-consult")!.handler("some-new-model", rec.ctx);
  expect(rec.notices.join("\n")).toContain("some-new-model");
});
