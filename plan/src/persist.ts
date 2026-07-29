/**
 * Persisting the plan into the session, and rebuilding it on the way back.
 *
 * Restore is the one place pi-plan reads state it did not just construct, so it is the one
 * place the invariants can arrive broken — from a hand-edited session file, a fork of a
 * session written by an older version, or a truncated write. pi-goal learned the narrow
 * version of this: an unrecognised status reaches `MARKERS[status]`, yields `undefined`,
 * and puts the literal string into the agent's context rather than failing anywhere
 * visible. With a lifecycle to protect, there is more to re-establish than one enum.
 */
import { oneOf } from "../../shared/fields.ts";
import {
  ITEM_STATUSES,
  OBJECTIVE_STATUSES,
  OUTCOMES,
  emptyPlan,
  type ItemStatus,
  type LogEntry,
  type Objective,
  type ObjectiveStatus,
  type Outcome,
  type Plan,
  type PlanItem,
  type Step,
} from "./state.ts";

/** Custom-entry type used to persist the plan in the session (not sent to the LLM). */
const ENTRY_TYPE = "plan-state";

interface AppendCapable {
  appendEntry: (customType: string, data?: unknown) => void;
}

interface BranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}
interface RestoreCtx {
  sessionManager?: { getBranch: () => BranchEntry[] } | null;
}

/** Persist the plan as a `plan-state` custom entry. */
export function appendState(pi: AppendCapable, plan: Plan): void {
  pi.appendEntry(ENTRY_TYPE, { plan });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;

function readObjective(raw: unknown): Objective | null {
  if (!isRecord(raw)) return null;
  const objective = nonEmpty(raw.objective);
  if (!objective) return null;
  const restored: Objective = {
    objective,
    status: oneOf<ObjectiveStatus>(raw.status, OBJECTIVE_STATUSES, "active"),
  };
  const criteria = nonEmpty(raw.criteria);
  if (criteria) restored.criteria = criteria;
  return restored;
}

function readSteps(raw: unknown): Step[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps = raw
    .filter(isRecord)
    .map((s) => ({ content: nonEmpty(s.content), done: s.done === true }))
    .filter((s): s is { content: string; done: boolean } => s.content !== null);
  return steps.length > 0 ? steps : undefined;
}

function readLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((e) => {
    const content = nonEmpty(e.content);
    const note = nonEmpty(e.note);
    // Both are required by every path that writes one. An entry missing either is not a
    // record of anything, and keeping it would put a blank line in the agent's context.
    if (!content || !note) return [];
    return [{ content, outcome: oneOf<Outcome>(e.outcome, OUTCOMES, "done"), note }];
  });
}

/**
 * Rebuild the plan from the most recent `plan-state` entry, re-establishing every
 * invariant the reducers maintain:
 *
 * - **at most one `active` item** — the first survives, the rest are demoted to `pending`
 * - **an `active` item has an approach** — one without is demoted rather than left in a
 *   state `applyStart` could never have produced, and which `gateEdit` would otherwise
 *   have to treat as blocking forever
 * - **`seq` is ahead of every id in use** — so a restored session cannot hand out an id
 *   that an existing item or an older log entry already refers to
 *
 * Returns an empty plan when there is no entry, and also when the newest one recorded a
 * reset — the newest entry wins, so `/pi-plan reset` survives a fork rather than being
 * undone by the older entry sitting behind it.
 */
export function restoreState(ctx: RestoreCtx): Plan {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;

    const stored = (entry.data as { plan?: unknown } | undefined)?.plan;
    if (!isRecord(stored)) return emptyPlan();

    let seenActive = false;
    const items: PlanItem[] = (Array.isArray(stored.items) ? stored.items : [])
      .filter(isRecord)
      .flatMap((raw) => {
        const content = nonEmpty(raw.content);
        const id = nonEmpty(raw.id);
        if (!content || !id) return [];

        let status = oneOf<ItemStatus>(raw.status, ITEM_STATUSES, "pending");
        const approach = nonEmpty(raw.approach);
        // Demote rather than repair: an active item with no approach never came from
        // `applyStart`, and inventing one would put words in the agent's mouth.
        if (status === "active" && (!approach || seenActive)) status = "pending";
        if (status === "active") seenActive = true;

        const item: PlanItem = { id, content, status };
        if (approach) item.approach = approach;
        const steps = readSteps(raw.steps);
        if (steps) item.steps = steps;
        return [item];
      });

    const log = readLog(stored.log);
    const highest = items.reduce((max, i) => Math.max(max, Number(i.id) || 0), 0);
    const stored_seq = typeof stored.seq === "number" && Number.isFinite(stored.seq) ? stored.seq : 0;

    return {
      objective: readObjective(stored.objective),
      items,
      log,
      seq: Math.max(Math.floor(stored_seq), highest + 1, 1),
    };
  }
  return emptyPlan();
}
