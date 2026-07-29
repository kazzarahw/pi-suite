/**
 * The plan, and the reducers that move it.
 *
 * Everything here is pure and deterministic — no clock, so tests reproduce, matching what
 * pi-todo's and pi-goal's reducers did before the merge.
 *
 * The shape is three parts and no tree: a flat list of **open** items, a disposable
 * **worksheet** on whichever one is active, and an append-only **log** of what was
 * resolved and how. The lifecycle is the abstraction: entering work costs an approach,
 * finishing costs a note, abandoning costs a reason, and exactly one item is active at a
 * time. That last rule is the one that separates a workflow from a wishlist.
 *
 * `Objective` stays local to pi-plan rather than moving to `shared/events.ts`: the bus
 * payloads carry plain strings, so no other extension needs the type. `PlanItem` lives in
 * shared only because `plan:updated` genuinely carries one — the same argument `TodoItem`
 * made before it.
 */
import { ITEM_STATUSES, type ItemStatus, type PlanItem, type Step } from "../../shared/index.ts";

export { ITEM_STATUSES };
export type { ItemStatus, PlanItem, Step };

/**
 * How a resolved item ended. Feed into `StringEnum(OUTCOMES)` if it ever reaches a schema;
 * today it is chosen by which verb was called, never supplied by the agent.
 */
export const OUTCOMES = ["done", "dropped"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * A resolved item. The worksheet is gone by now — once an item is done nobody cares about
 * its five steps — so what survives is what it was and what came of it.
 */
export interface LogEntry {
  content: string;
  outcome: Outcome;
  /** What the outcome was (`done`) or why it was abandoned (`dropped`). Required either way. */
  note: string;
}

/** The objective's statuses, in order. */
export const OBJECTIVE_STATUSES = ["active", "met"] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/** The one objective the session is working toward. */
export interface Objective {
  /** The objective itself, in one sentence. */
  objective: string;
  /** How the agent will know it is met. Absent when the objective speaks for itself. */
  criteria?: string;
  status: ObjectiveStatus;
}

/** An objective as supplied by the agent: `status` optional, defaulting to `active`. */
export interface ObjectiveInput {
  objective: string;
  criteria?: string;
  status?: ObjectiveStatus;
}

/** An item as supplied by the agent: `id` optional, assigned or preserved by us. */
export interface ItemInput {
  id?: string;
  content: string;
}

export interface Plan {
  objective: Objective | null;
  /** Open work only, in order. */
  items: PlanItem[];
  /** Resolved work, in resolution order. Append-only. */
  log: LogEntry[];
  /**
   * Next ordinal to assign. Monotonic, so a resolved id is never handed out again and a
   * log entry can never be confused with a live item.
   */
  seq: number;
}

export const emptyPlan = (): Plan => ({ objective: null, items: [], log: [], seq: 1 });

/** The active item, or `null`. There is at most one — see {@link applyStart}. */
export function activeItem(plan: Plan): PlanItem | null {
  return plan.items.find((i) => i.status === "active") ?? null;
}

const fail = (message: string): never => {
  // Throwing is the mechanism: Pi sets `isError` on a tool result only when `execute`
  // throws, so a refused transition has to throw rather than return prose about itself.
  throw new Error(`[pi-plan] ${message}`);
};

// ---------------------------------------------------------------------------
// The objective.
// ---------------------------------------------------------------------------

/** Result of an objective write. */
export interface ObjectiveResult {
  plan: Plan;
  /** The objective transitioned to `met` in this write (drives `plan:met`). */
  newlyMet: boolean;
}

/**
 * Replace the objective. Ported from pi-goal's `applySet`, whose rules were already right.
 *
 * Rules beyond the plain replace, all keyed on the objective text, which is the only
 * identity an objective has:
 *
 * - **Omitted fields carry forward** across a restatement of the same objective. Marking
 *   one met is the common second call and should not have to repeat the criteria to keep
 *   them; equally, restating an objective to amend its criteria must not quietly reopen
 *   one already met. Both directions matter, so `status` carries the same way `criteria`
 *   does — an earlier version of this carried only `criteria`, and the asymmetry made
 *   restating a met objective a silent regression to `active`. Reopening is still
 *   available; it just has to be said, with an explicit `status: "active"`.
 * - **`newlyMet` is idempotent against the state it is given.** Restating an already-met
 *   objective reports nothing, so a repeated call cannot emit `plan:met` twice.
 */
export function applyObjective(plan: Plan, incoming: ObjectiveInput): ObjectiveResult {
  const prev = plan.objective;
  const restated = prev !== null && prev.objective === incoming.objective;
  const criteria = incoming.criteria ?? (restated ? prev.criteria : undefined);
  const status = incoming.status ?? (restated ? prev.status : "active");

  const objective: Objective = { objective: incoming.objective, status };
  if (criteria) objective.criteria = criteria;

  const newlyMet = objective.status === "met" && !(restated && prev.status === "met");
  return { plan: { ...plan, objective }, newlyMet };
}

// ---------------------------------------------------------------------------
// The open list.
// ---------------------------------------------------------------------------

/**
 * Full replace of the **open** list.
 *
 * Ids are preserved by explicit id or by content match, which is what carries an item's
 * status, approach, and worksheet across a rewrite — the agent sends `{ content }` and
 * gets its own in-flight work back intact. New items draw an ordinal from `seq`.
 *
 * **The active item may not be omitted.** Dropping active work by leaving it out of a
 * rewrite is precisely the silent failure this extension exists to stop: it is either
 * finished, or abandoned with a reason, and both are explicit calls. The log is likewise
 * unreachable from here — you may revise the future, never the past.
 */
export function applyItems(plan: Plan, incoming: ItemInput[]): { plan: Plan } {
  const claimed = new Set<string>();
  let seq = plan.seq;

  const items: PlanItem[] = incoming.map((inc) => {
    const match = inc.id
      ? plan.items.find((p) => p.id === inc.id && !claimed.has(p.id))
      : plan.items.find((p) => p.content === inc.content && !claimed.has(p.id));
    if (!match) {
      return { id: String(seq++), content: inc.content, status: "pending" as ItemStatus };
    }
    claimed.add(match.id);
    // Carry the whole item forward, not just its id: an active item rewritten by content
    // keeps the approach it was started with and the worksheet it has been ticking.
    const kept: PlanItem = { ...match, content: inc.content };
    return kept;
  });

  const active = activeItem(plan);
  if (active && !items.some((i) => i.id === active.id)) {
    fail(
      `the active item "${active.content}" (id ${active.id}) is missing from the list — ` +
        `finish it with action "finish" or abandon it with action "drop", but do not drop it silently`,
    );
  }
  return { plan: { ...plan, items, seq } };
}

// ---------------------------------------------------------------------------
// The lifecycle.
// ---------------------------------------------------------------------------

/**
 * Activate an item, which is the moment the approach has to exist.
 *
 * Supplying it *is* the decompose-before-you-commit step, and it is why `start` costs
 * something that `in_progress` did not: pi-todo let the agent declare work started for
 * free, so it did, before it had thought about how.
 */
export function applyStart(
  plan: Plan,
  id: string,
  approach: string,
  steps?: string[],
): { plan: Plan } {
  const current = activeItem(plan);
  if (current) {
    fail(
      `"${current.content}" (id ${current.id}) is already active — finish or drop it before starting another. ` +
        `One item at a time is the whole point.`,
    );
  }
  const target = plan.items.find((i) => i.id === id);
  if (!target) fail(`no open item with id ${id}`);
  const trimmed = approach.trim();
  if (!trimmed) fail(`action "start" requires a non-empty approach`);

  const started: PlanItem = { ...target!, status: "active", approach: trimmed };
  if (steps && steps.length > 0) {
    started.steps = steps.map((content) => ({ content, done: false }));
  }
  return { plan: { ...plan, items: plan.items.map((i) => (i.id === id ? started : i)) } };
}

/** A worksheet edit: tick/untick one step, or append more. */
export type StepEdit = { index: number; done: boolean } | { steps: string[] };

/** Tick, untick, or extend the active item's worksheet. */
export function applyStep(plan: Plan, edit: StepEdit): { plan: Plan } {
  const active = activeItem(plan);
  if (!active) fail(`nothing is active — call action "start" first`);

  const steps = [...(active!.steps ?? [])];
  if ("steps" in edit) {
    steps.push(...edit.steps.map((content) => ({ content, done: false })));
  } else {
    const at = steps[edit.index];
    if (!at) fail(`no step at index ${edit.index} (the worksheet has ${steps.length})`);
    steps[edit.index] = { ...at!, done: edit.done };
  }
  const updated: PlanItem = { ...active!, steps };
  return { plan: { ...plan, items: plan.items.map((i) => (i.id === updated.id ? updated : i)) } };
}

/**
 * Promote a step to a real item, directly after the active one.
 *
 * The promotion is itself a signal: a step that turned out to need its own approach was
 * work the agent underestimated when it wrote the worksheet.
 */
export function applyPromote(plan: Plan, index: number): { plan: Plan; item: PlanItem } {
  const active = activeItem(plan);
  if (!active) fail(`nothing is active — there is no worksheet to promote from`);

  const steps = [...(active!.steps ?? [])];
  const step = steps[index];
  if (!step) fail(`no step at index ${index} (the worksheet has ${steps.length})`);
  steps.splice(index, 1);

  const promoted: PlanItem = { id: String(plan.seq), content: step!.content, status: "pending" };
  const items = plan.items.map((i) => (i.id === active!.id ? { ...active!, steps } : i));
  items.splice(items.findIndex((i) => i.id === active!.id) + 1, 0, promoted);

  return { plan: { ...plan, items, seq: plan.seq + 1 }, item: promoted };
}

/** Resolve the active item as done. The worksheet is discarded; the note survives it. */
export function applyFinish(plan: Plan, note: string): { plan: Plan; entry: LogEntry } {
  const active = activeItem(plan);
  if (!active) fail(`nothing is active — call action "start" first`);
  const trimmed = note.trim();
  if (!trimmed) fail(`action "finish" requires a note saying what the outcome was`);

  const entry: LogEntry = { content: active!.content, outcome: "done", note: trimmed };
  return {
    plan: {
      ...plan,
      items: plan.items.filter((i) => i.id !== active!.id),
      log: [...plan.log, entry],
    },
    entry,
  };
}

/**
 * Abandon an open item, active or not.
 *
 * This is the exit that pi-todo did not have. Work that turned out to be unnecessary was
 * either marked `done` — a lie — or left `pending` forever, and the list filled with
 * noise either way. Here it costs a reason and leaves a record.
 */
export function applyDrop(plan: Plan, id: string, reason: string): { plan: Plan; entry: LogEntry } {
  const target = plan.items.find((i) => i.id === id);
  if (!target) fail(`no open item with id ${id}`);
  const trimmed = reason.trim();
  if (!trimmed) fail(`action "drop" requires a reason`);

  const entry: LogEntry = { content: target!.content, outcome: "dropped", note: trimmed };
  return {
    plan: { ...plan, items: plan.items.filter((i) => i.id !== id), log: [...plan.log, entry] },
    entry,
  };
}

// ---------------------------------------------------------------------------
// The user's overrides.
// ---------------------------------------------------------------------------

/**
 * `/pi-plan clear` — forget the objective, the open list, and the worksheet.
 *
 * **The log and `seq` survive.** `clear` means *the plan was wrong, re-plan*, and the
 * record of what was already tried and abandoned is exactly what should carry into the
 * re-plan — otherwise the agent is free to re-propose the thing it just dropped. `seq`
 * survives with it so a new item can never take an id a log entry already refers to.
 *
 * It still fully disarms the gate: `gateEdit` arms on an objective or an open item, and
 * this leaves neither. A reducer rather than inline command logic so that property is
 * unit-testable.
 */
export function applyClear(plan: Plan): { plan: Plan } {
  return { plan: { objective: null, items: [], log: plan.log, seq: plan.seq } };
}
