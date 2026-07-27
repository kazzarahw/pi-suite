/**
 * The `/pi-<name>` configuration command, as data.
 *
 * All seven extensions expose one command and it does the same four things: set a field
 * from an argument, print a readout when there is no TUI, open the settings panel when
 * there is, and persist each toggle. That shape was written out seven times — about five
 * hundred lines — and the copies disagreed in ways nobody chose: three different ways to
 * split the arguments, `getArgumentCompletions` on three of seven, and every field's
 * validation, display transform, and notify string inlined into a closure.
 *
 * It was also the least-tested code in the suite, at 14–28% line coverage, and those two
 * facts are the same fact: seven bespoke closures need seven test suites, so they got
 * none. One engine over seven field tables needs one.
 *
 * An extension declares its fields; everything below is shared. Verbs that are genuinely
 * not fields — pi-memory's `delete <name>`, pi-lens's health readout — go through
 * `extraVerbs`, because forcing them into the table would be the same mistake in the
 * other direction.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, SettingItem } from "@earendil-works/pi-tui";
import { openSettingsPanel } from "./settings-panel.ts";

/**
 * How a field's stored value is shown to a user.
 *
 * Several fields store `""` or `undefined` to mean "decide at runtime", and a settings
 * panel showing an empty row for that reads as broken. Each extension hand-rolled the
 * substitution — `"(autodetect)"`, `"(pi default)"`, `"(default)"` — along with the
 * inverse mapping on the way back in, and getting only one direction right would
 * silently persist the placeholder as the value.
 */
export interface Display {
  /** Placeholder shown when the stored value is `""` or `undefined`. */
  readonly placeholder: string;
  /**
   * What to store when the user picks the placeholder. Defaults to `""`.
   *
   * Set it explicitly to `undefined` for an optional key that should be *removed* rather
   * than blanked — pi-browser's `session`, where absent means "agent-browser's own
   * default". Read with an `in` check below, not `??`, because `undefined ?? ""` would
   * silently turn that intent back into an empty string.
   */
  readonly storedWhenPlaceholder?: string | undefined;
}

interface FieldBase<T> {
  /** The config key this field reads and writes. */
  readonly key: keyof T & string;
  /** Row label in the settings panel. */
  readonly label: string;
  /**
   * The `/<command> <verb> <value>` word. Defaults to the key, lowercased — the config
   * keys are camelCase and the CLI verbs were already all lowercase.
   */
  readonly verb?: string;
  readonly display?: Display;
}

/**
 * Preset values offered in the panel and in completions.
 *
 * A thunk when the list comes from config rather than from the code — for a field whose
 * presets are themselves a user-editable config key, capturing them once at extension
 * load would leave the list stale for the rest of the session, while everything else in
 * the suite reads config per call.
 *
 * Every field in the suite passes a literal array today; the thunk is the seam that lets
 * one not have to. Kept for the same reason an event with no in-repo subscriber is kept:
 * it is a working extension point of the shared engine, not unfinished code.
 */
export type Presets<V> = readonly V[] | (() => readonly V[]);

const resolvePresets = <V,>(p: Presets<V> | undefined): readonly V[] =>
  typeof p === "function" ? p() : (p ?? []);

/**
 * How an int field reads, for the fields whose number means nothing on its own.
 *
 * `/pi-git` showed `Keep checkpoints for 30` and `Max file size 10485760` — one value
 * with no unit and one in bytes, in a panel where every other row (`notify`, `on`,
 * `(autodetect)`) says what it is. A raw byte count is the worst of them: nobody reads
 * 10485760 as ten megabytes.
 *
 * A pair, not a formatter, because the panel round-trips this string: it offers
 * `panelValues` and hands the chosen one straight back to `parseValue`. Anything
 * `format` can produce, `parse` must therefore accept. `parse` returning `null` falls
 * through to the plain-number reading, so `/pi-git ttl 30` keeps working and a config
 * file edited by hand is untouched — this is a display concern, and the stored value
 * stays the number it always was.
 */
export interface Unit {
  format(value: number): string;
  /** The number this display string means, or `null` when it is not one. */
  parse(input: string): number | null;
}

export type Field<T> =
  | (FieldBase<T> & { readonly kind: "enum"; readonly values: readonly string[] })
  | (FieldBase<T> & { readonly kind: "bool" })
  | (FieldBase<T> & {
      readonly kind: "int";
      readonly presets?: Presets<number>;
      readonly min?: number;
      readonly unit?: Unit;
    })
  | (FieldBase<T> & { readonly kind: "string"; readonly presets?: Presets<string> });

/** A verb that is not a config field — an action, or a field needing bespoke handling. */
export interface ExtraVerb {
  readonly verb: string;
  /** Shown in the `unknown option` hint, e.g. `"delete <name>"`. */
  readonly usage: string;
  /**
   * Handle the verb. Return a message to notify at `"info"`, or `null` to stay silent
   * (the handler reported for itself). Throw nothing — report errors via `notify`.
   */
  handle(value: string, ctx: ExtensionCommandContext, notify: Notify): void | Promise<void>;
}

/** Prefixed notification, so no call site repeats the `[pi-<name>]` tag. */
export interface Notify {
  info(message: string): void;
  error(message: string): void;
  warn(message: string): void;
}

export interface ConfigCommandOptions<T> {
  /** One-line description for the command list. Defaults to a generated one. */
  readonly description?: string;
  /** Settings-panel subtitle. A function when it depends on live state (a roster, a health probe). */
  readonly subtitle?: string | ((ctx: ExtensionCommandContext) => string);
  /** Verbs that are not fields. */
  readonly extraVerbs?: readonly ExtraVerb[];
  /**
   * Extra text for the no-TUI readout, appended after the field summary. For state the
   * fields do not capture — pi-lens's toolchain health, pi-spawn's agent roster.
   */
  readonly readoutExtra?: (cfg: T, ctx: ExtensionCommandContext) => string | undefined;
  /**
   * Accept a bare value as this field, with no verb: `/pi-todo block` rather than
   * `/pi-todo mode block`. Only sound when one field could plausibly be meant.
   */
  readonly bareValueField?: keyof T & string;
}

export interface ConfigCommandDeps<T> {
  loadConfig(): T;
  saveConfig(cfg: T): void;
}

const verbOf = <T,>(field: Field<T>): string => field.verb ?? field.key.toLowerCase();

/** The stored value as a user should see it — placeholder substituted for blank. */
export function displayValue<T>(field: Field<T>, cfg: T): string {
  const raw = cfg[field.key];
  if (field.display && (raw === "" || raw === undefined)) return field.display.placeholder;
  if (field.kind === "bool") return raw ? "on" : "off";
  if (field.kind === "int" && field.unit && typeof raw === "number") return field.unit.format(raw);
  return String(raw ?? "");
}

/**
 * A user-supplied string as a stored value, or an error message.
 *
 * Returning the message rather than throwing keeps this pure and total: the settings
 * panel and the argument form both need the same validation, and only one of them has
 * somewhere to put an exception.
 */
export function parseValue<T>(field: Field<T>, input: string): { value: unknown } | { error: string } {
  if (field.display && input === field.display.placeholder) {
    // `in`, not `??`: an explicit `storedWhenPlaceholder: undefined` means "remove the
    // key", and `??` cannot tell that apart from the property being absent.
    return {
      value: "storedWhenPlaceholder" in field.display ? field.display.storedWhenPlaceholder : "",
    };
  }
  switch (field.kind) {
    case "enum":
      return field.values.includes(input)
        ? { value: input }
        : { error: `invalid ${verbOf(field)} "${input}" (use: ${field.values.join(", ")})` };
    case "bool": {
      if (["on", "true", "yes"].includes(input)) return { value: true };
      if (["off", "false", "no"].includes(input)) return { value: false };
      return { error: `${verbOf(field)} must be on or off (got "${input}")` };
    }
    case "int": {
      // The unit first, so the panel's own `10 MB` parses; a bare number after it, so
      // the argument form and a hand-edited config keep meaning exactly what they did.
      const n = field.unit?.parse(input) ?? Number(input);
      const min = field.min ?? 1;
      return Number.isInteger(n) && n >= min
        ? { value: n }
        : {
            error: `${verbOf(field)} must be an integer >= ${field.unit ? field.unit.format(min) : min} (got "${input}")`,
          };
    }
    case "string":
      // A field with no `display` has no rendering for a blank value, which means blank
      // is not a value it can hold — `/pi-browser binpath` with no argument used to
      // store `""` and leave the config naming a binary that cannot be executed. The
      // correlation is exact and not a coincidence: the fields in the suite without a
      // placeholder (`browser.binPath`) are precisely the ones whose `ConfigSpec` reads
      // them with `nonEmptyStr`. Fields that DO have one keep
      // accepting `""`, because there it means something — pi-lens's autodetect.
      if (!field.display && input === "") {
        return { error: `${verbOf(field)} needs a value` };
      }
      return { value: input };
  }
}

/** The panel's value list: whatever is stored now, then the presets, deduped. */
function panelValues<T>(field: Field<T>, cfg: T): string[] {
  const current = displayValue(field, cfg);
  const presets: string[] = [];
  if (field.display) presets.push(field.display.placeholder);
  switch (field.kind) {
    case "enum":
      presets.push(...field.values);
      break;
    case "bool":
      presets.push("on", "off");
      break;
    case "int":
      presets.push(...resolvePresets(field.presets).map((n) => (field.unit ? field.unit.format(n) : String(n))));
      break;
    case "string":
      presets.push(...resolvePresets(field.presets));
      break;
  }
  const values = [...new Set([current, ...presets])];
  // Numeric rows read as a jumble unless ordered; everything else keeps declaration
  // order, which is deliberate (modes go off → notify → block, not alphabetically).
  // Sorted by what the row *means*, not by its text: `Number("10 MB")` is NaN, which
  // would leave a unit-bearing field in whatever order the set happened to produce.
  if (field.kind !== "int") return values;
  const asNumber = (s: string): number => field.unit?.parse(s) ?? Number(s);
  return values.sort((a, b) => asNumber(a) - asNumber(b));
}

/** What `pi.registerCommand(name, options)` takes — the shape Pi's registry expects. */
export interface CommandOptions {
  description: string;
  getArgumentCompletions(prefix: string): AutocompleteItem[] | null;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

/** Build the `/pi-<name>` command from a field table. */
export function defineConfigCommand<T extends object>(
  name: string,
  fields: readonly Field<T>[],
  deps: ConfigCommandDeps<T>,
  opts: ConfigCommandOptions<T> = {},
): { name: string; options: CommandOptions } {
  const command = `pi-${name}`;
  const byVerb = new Map(fields.map((f) => [verbOf(f), f]));
  const extras = new Map((opts.extraVerbs ?? []).map((v) => [v.verb, v]));

  const usage = [
    ...fields.map((f) => {
      const v = verbOf(f);
      if (f.kind === "bool") return `${v} on|off`;
      if (f.kind === "enum") return `${v} <${f.values.join("|")}>`;
      return `${v} <value>`;
    }),
    ...(opts.extraVerbs ?? []).map((v) => v.usage),
  ].join(" | ");

  const notifierFor = (ctx: ExtensionCommandContext): Notify => ({
    info: (m) => ctx?.ui?.notify?.(`[${command}] ${m}`, "info"),
    error: (m) => ctx?.ui?.notify?.(`[${command}] ${m}`, "error"),
    warn: (m) => ctx?.ui?.notify?.(`[${command}] ${m}`, "warning"),
  });

  /** Validate and persist one field. Returns false when nothing was written. */
  const apply = (field: Field<T>, input: string, notify: Notify): boolean => {
    const parsed = parseValue(field, input);
    if ("error" in parsed) {
      notify.error(parsed.error);
      return false;
    }
    // Re-read rather than closing over an earlier snapshot: the settings panel fires
    // this once per toggle, and a stale base would silently revert the previous one.
    deps.saveConfig({ ...deps.loadConfig(), [field.key]: parsed.value });
    return true;
  };

  return {
    name: command,
    options: {
      description:
        opts.description ??
        `Configure ${command}: '/${command}' opens the settings panel; or ${usage}.`,

      /**
       * Complete the first word. Every command gets this — three of seven had it before,
       * for no reason anyone recorded.
       */
      getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
        const words = [...byVerb.keys(), ...extras.keys()];
        // A bare-value command also completes that field's values: `/pi-todo <TAB>`
        // should offer off/notify/block, and a string field's presets complete the same
        // way — both are things a user types straight after the command name.
        if (opts.bareValueField) {
          const field = fields.find((f) => f.key === opts.bareValueField);
          if (field?.kind === "enum") words.push(...field.values);
          else if (field?.kind === "string") words.push(...resolvePresets(field.presets));
        }
        const items = [...new Set(words)]
          .filter((w) => w.startsWith(prefix))
          .map((w) => ({ value: w, label: w }));
        return items.length > 0 ? items : null;
      },

      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const notify = notifierFor(ctx);
        const trimmed = args.trim();
        // Split on the FIRST space only. Splitting on all whitespace and rejoining —
        // which three of the seven did — collapses runs of spaces inside a value, and
        // `verify  npm  test` is a command a user may legitimately type.
        const sp = trimmed.indexOf(" ");
        const head = sp === -1 ? trimmed : trimmed.slice(0, sp);
        const value = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

        if (head) {
          const field = byVerb.get(head);
          if (field) {
            if (apply(field, value, notify)) {
              notify.info(`${verbOf(field)} set to: ${value || displayValue(field, deps.loadConfig())}`);
            }
            return;
          }
          const extra = extras.get(head);
          if (extra) {
            await extra.handle(value, ctx, notify);
            return;
          }
          // A bare value for the designated field: `/pi-git notify`.
          if (opts.bareValueField) {
            const bare = fields.find((f) => f.key === opts.bareValueField);
            if (bare) {
              if (apply(bare, trimmed, notify)) notify.info(`${verbOf(bare)} set to: ${trimmed}`);
              return;
            }
          }
          notify.error(`unknown option "${head}" (use: ${usage})`);
          return;
        }

        const cfg = deps.loadConfig();

        // No TUI (print/JSON/rpc): a text readout, since there is nothing to open.
        if (ctx.mode !== "tui") {
          const summary = fields.map((f) => `${verbOf(f)}: ${displayValue(f, cfg)}`).join(" · ");
          notify.info(summary);
          const extra = opts.readoutExtra?.(cfg, ctx);
          if (extra) notify.info(extra);
          return;
        }

        const items: SettingItem[] = fields.map((f) => ({
          id: f.key,
          label: f.label,
          currentValue: displayValue(f, cfg),
          values: panelValues(f, cfg),
        }));
        const subtitle =
          typeof opts.subtitle === "function" ? opts.subtitle(ctx) : (opts.subtitle ?? "");
        await openSettingsPanel(ctx, `${command} · settings`, subtitle, items, (id, val) => {
          const field = fields.find((f) => f.key === id);
          // The panel only ever emits ids it was given, but a silent no-op on a
          // mismatch is how a renamed key stops persisting without anyone noticing.
          if (field) apply(field, val, notify);
        });
      },
    },
  };
}

/** `enum` field — a fixed value set, shown in declaration order. */
export const enumField = <T,>(
  key: keyof T & string,
  values: readonly string[],
  label: string,
  extra: Partial<FieldBase<T>> = {},
): Field<T> => ({ kind: "enum", key, values, label, ...extra });

/** `bool` field — accepts on/true/yes and off/false/no, displays on/off. */
export const boolField = <T,>(
  key: keyof T & string,
  label: string,
  extra: Partial<FieldBase<T>> = {},
): Field<T> => ({ kind: "bool", key, label, ...extra });

/** `int` field — validated to an integer at or above `min` (default 1). */
export const intField = <T,>(
  key: keyof T & string,
  label: string,
  extra: Partial<FieldBase<T>> & { presets?: Presets<number>; min?: number; unit?: Unit } = {},
): Field<T> => ({ kind: "int", key, label, ...extra });

/** A count of days: `30 days`, `1 day`. Accepts `30`, `30d`, `30 days`. */
export const DAYS: Unit = {
  format: (n) => `${n} day${n === 1 ? "" : "s"}`,
  parse: (input) => {
    const m = /^(\d+)\s*(d|days?)?$/i.exec(input.trim());
    return m ? Number(m[1]) : null;
  },
};

/**
 * A byte count, read and written in MB: `10 MB`.
 *
 * Stored as bytes — the config key is `maxFileBytes` and comparing it against a file
 * size must not go through a display unit. `.5 MB` rather than a rounded `1 MB` for a
 * value that is not a whole number of them, so the panel can never show a size the
 * config does not hold.
 *
 * A bare number stays bytes, which is what it has always meant in the JSON file and in
 * `/pi-git maxbytes 10485760`.
 */
const MIB = 1_048_576;
export const MEGABYTES: Unit = {
  format: (n) => {
    const mb = n / MIB;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  },
  parse: (input) => {
    const m = /^([\d.]+)\s*(mb|mib|m)$/i.exec(input.trim());
    if (!m) return null;
    const mb = Number(m[1]);
    return Number.isFinite(mb) ? Math.round(mb * MIB) : null;
  },
};

/** `string` field — free text, optionally with presets offered in the panel. */
export const stringField = <T,>(
  key: keyof T & string,
  label: string,
  extra: Partial<FieldBase<T>> & { presets?: Presets<string> } = {},
): Field<T> => ({ kind: "string", key, label, ...extra });
