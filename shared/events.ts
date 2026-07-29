/**
 * The cross-extension event vocabulary.
 *
 * Event names are namespaced `domain:event`. Payloads are documented here so a
 * type mismatch between an emitter and a subscriber is caught by the compiler
 * rather than at runtime. Emit/subscribe through `pi.events`.
 */

/** A single diagnostic, shared by pi-lens emissions and any subscriber. */
export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
  code?: string;
}

/**
 * The todo statuses, in order. Feed into `StringEnum(TODO_STATUSES)` when building
 * pi-todo's tool schema so the wire enum stays in sync with {@link TodoStatus}.
 */
export const TODO_STATUSES = ["pending", "in_progress", "done"] as const;

/** Status of a todo item (pi-todo). */
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** A single todo item, shared by pi-todo emissions and any subscriber. */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * The payload shape for every event, keyed by event name. The single source of
 * truth for the `domain:event` contract — emitters and subscribers both index
 * into this map, so drift is a type error.
 *
 * **Payloads must be self-contained.** A subscriber is handed `data` and nothing
 * else — no `ExtensionContext`, so no `cwdOf`, no `ctx.ui`. Anything a handler needs
 * belongs here. pi-memory learned this the hard way: with no cwd on `verify:failed`
 * it kept a module-level latch of the last cwd it had seen from an unrelated hook,
 * and before that it fell back to `process.cwd()` and wrote captured memories beside
 * whatever directory Pi happened to be launched from.
 *
 * It is also what keeps extensions swappable. A subscriber that needs nothing but the
 * payload works against *any* publisher of an event, not just the sibling that
 * happens to ship today.
 */
export interface EventPayloads {
  "lens:clean": { file: string };
  "lens:issues": { file: string; diagnostics: Diagnostic[] };
  /** `cwd` is the project the command ran in — see the self-contained rule above. */
  "verify:passed": { cmd: string; cwd: string };
  "verify:failed": { cmd: string; failures: string[]; cwd: string };

  /**
   * File state recorded against a session entry. `files` is how many paths it covered.
   *
   * These two declared `{ ref, reason }` until the `Emitter` type below was introduced,
   * while pi-git had been emitting `entryId` and a count since the store stopped being
   * git-backed and `ref` stopped existing. Nothing caught it: this map's own doc comment
   * promised the compiler would, and the compiler was never given the chance, because
   * every extension emitted through `(event: string, data: unknown)`. A subscriber
   * written against the declaration would have read `data.ref` and got `undefined`.
   */
  "git:checkpoint": { entryId: string; files: number; reason: string };
  "git:rollback": {
    entryId: string;
    written: number;
    removed: number;
    reason: string;
  };

  "todo:updated": { todos: TodoItem[] };
  "todo:task-complete": { task: string };

  /** The session's overarching objective, as stated or restated (pi-goal). */
  "goal:set": { objective: string; criteria?: string };
  "goal:met": { objective: string };

  "memory:wrote": { keys: string[] };
  "memory:recalled": { keys: string[] };

  /**
   * A delegation is about to run in its own `pi` process.
   *
   * `cwd` is the project the subagent will work in — the self-contained rule again, and
   * here it is load-bearing rather than defensive: pi-git subscribes to this to record
   * the working set *before* edits it will never see through `tool_call` land on disk,
   * and a bus callback gets no `ExtensionContext` to resolve a directory from.
   */
  "spawn:started": { agent: string; cwd: string };
  "spawn:finished": { agent: string; cwd: string; summary?: string };
}

/** Every valid event name. */
export type EventName = keyof EventPayloads;

/**
 * How an extension emits. **Use this type for every `emit` dependency.**
 *
 * The map above has always said a mismatch between emitter and subscriber "is caught by
 * the compiler rather than at runtime". That was not true: `pi.events.emit` takes
 * `(string, unknown)`, and every extension declared its own `emit` dep the same way, so
 * the map was documentation that merely resembled a type. `git:checkpoint` drifted
 * behind it — declared `{ ref }`, emitting `{ entryId, files }` — and stayed wrong
 * across the rewrite that removed `ref`.
 *
 * Binding the name to its payload makes the claim real: an unknown event name and a
 * payload of the wrong shape are both compile errors at the call site.
 */
export type Emitter = <E extends EventName>(
  event: E,
  data: EventPayloads[E],
) => void;

/**
 * Event-name constants, grouped by domain. Reference these instead of typing
 * the string literal so a rename is a single edit and typos are caught.
 */
export const EVENTS = {
  lens: { clean: "lens:clean", issues: "lens:issues" },
  verify: { passed: "verify:passed", failed: "verify:failed" },
  git: { checkpoint: "git:checkpoint", rollback: "git:rollback" },
  todo: { updated: "todo:updated", taskComplete: "todo:task-complete" },
  goal: { set: "goal:set", met: "goal:met" },
  memory: { wrote: "memory:wrote", recalled: "memory:recalled" },
  spawn: { started: "spawn:started", finished: "spawn:finished" },
} as const satisfies Record<string, Record<string, EventName>>;
