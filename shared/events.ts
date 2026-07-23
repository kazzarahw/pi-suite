/**
 * The cross-extension event vocabulary (HOUSE-STYLE §4).
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

/** Status of a todo item (pi-todo). */
export type TodoStatus = "pending" | "in_progress" | "done";

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
 */
export interface EventPayloads {
  "consult:answered": { model: string; topic: string };

  "lens:clean": { file: string };
  "lens:issues": { file: string; diagnostics: Diagnostic[] };
  "verify:passed": { cmd: string };
  "verify:failed": { cmd: string; failures: string[] };

  "git:checkpoint": { ref: string; reason: string };
  "git:rollback": { ref: string; reason: string };

  "todo:updated": { todos: TodoItem[] };
  "todo:task-complete": { task: string };

  "memory:wrote": { keys: string[] };
  "memory:recalled": { keys: string[] };

  "spawn:started": { agent: string };
  "spawn:finished": { agent: string; summary?: string };
}

/** Every valid event name. */
export type EventName = keyof EventPayloads;

/**
 * Event-name constants, grouped by domain. Reference these instead of typing
 * the string literal so a rename is a single edit and typos are caught.
 */
export const EVENTS = {
  consult: { answered: "consult:answered" },
  lens: { clean: "lens:clean", issues: "lens:issues" },
  verify: { passed: "verify:passed", failed: "verify:failed" },
  git: { checkpoint: "git:checkpoint", rollback: "git:rollback" },
  todo: { updated: "todo:updated", taskComplete: "todo:task-complete" },
  memory: { wrote: "memory:wrote", recalled: "memory:recalled" },
  spawn: { started: "spawn:started", finished: "spawn:finished" },
} as const satisfies Record<string, Record<string, EventName>>;
