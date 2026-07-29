/**
 * The three renderings, and the one constraint that decides which state goes where.
 *
 * `formatInjection` is prepended to **every** LLM call, so it sits at message index 0
 * while the provider puts the conversation-history cache breakpoint on the *last* user
 * message — a cache hit needs the whole prefix to match. Anything in there that ticks over
 * invalidates the entire conversation cache on every single call, in exactly the long
 * sessions this extension exists to serve. pi-goal discovered this and its comment argued
 * it at length; merging a *living* plan into the same block is the obvious way to throw it
 * away, so the split is enforced by structure here: the standing block is built from the
 * objective and the active item alone, and nothing else is in scope to leak into it.
 *
 * Everything volatile — the open list, the worksheet's ticks, the counts, the log — goes
 * to the widget (free, always current) and to `formatResume`, which rides the
 * `session_start` / `session_compact` re-injection, where the cache is being rebuilt
 * anyway.
 */
import { injectionBlock } from "../../shared/index.ts";
import {
  activeItem,
  type ItemStatus,
  type LogEntry,
  type ObjectiveStatus,
  type Plan,
  type Step,
} from "./state.ts";
import type { VerifyState } from "./peers.ts";

const OBJECTIVE_MARKERS: Record<ObjectiveStatus, string> = { active: "▸", met: "✓" };
const ITEM_MARKERS: Record<ItemStatus, string> = { pending: "▢", active: "◐" };
const STEP_MARKERS: Record<"true" | "false", string> = { true: "▣", false: "▢" };
const OUTCOME_MARKERS = { done: "▣", dropped: "✕" } as const;

/**
 * Every rendered line is clipped.
 *
 * Not a style choice: `shared/README.md` is blunt that a custom component rendering wider
 * than the terminal crashes Pi outright with `Rendered line N exceeds terminal width`.
 * pi-goal clipped its one line; a plan draws as many lines as the work has parts, and each
 * of them can carry agent-authored text of any length.
 */
const WIDTH = 88;
const clip = (s: string, n: number = WIDTH): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const stepMarker = (s: Step): string => STEP_MARKERS[s.done ? "true" : "false"];

/** `3 done · 1 dropped · 2 open · verify ✓`, or `""` when there is nothing worth saying. */
function annotate(plan: Plan, verify: VerifyState | null): string {
  const done = plan.log.filter((e) => e.outcome === "done").length;
  const dropped = plan.log.filter((e) => e.outcome === "dropped").length;
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (dropped > 0) parts.push(`${dropped} dropped`);
  if (plan.items.length > 0) parts.push(`${plan.items.length} open`);
  // The command is not named here; the widget is a glance, and `verify ✓` is the whole
  // signal. The settle reminder names it, where the agent may need to act on it.
  if (verify) parts.push("verify ✓");
  return parts.join(" · ");
}

/**
 * Widget lines: the objective, a one-line tally, then the open list with the active
 * item's worksheet nested under it.
 *
 * Items are labelled with their **id**, not their position, because the id is what the
 * agent types back into `start` and `drop`. A position would be a second numbering the
 * agent has to reconcile against the one in the tool result.
 */
export function renderPlan(plan: Plan, verify: VerifyState | null = null): string[] {
  const lines: string[] = [];

  if (plan.objective) {
    lines.push(clip(`${OBJECTIVE_MARKERS[plan.objective.status]} ${plan.objective.objective}`));
  }
  const note = annotate(plan, verify);
  if (note) lines.push(clip(`  ${note}`));

  for (const item of plan.items) {
    lines.push(clip(`${item.id}. ${ITEM_MARKERS[item.status]} ${item.content}`));
    // Only the active item has a worksheet, so this nests at most one level — the flat
    // shape showing through in the rendering.
    for (const step of item.steps ?? []) {
      lines.push(clip(`     ${stepMarker(step)} ${step.content}`));
    }
  }
  return lines;
}

/**
 * The standing `<pi-plan>` block: the objective, its criteria, and the active item with
 * the approach it was started on. Nothing else, ever.
 *
 * **This must stay byte-identical for as long as the agent has not advanced.** It takes no
 * counts, no open list, and no log — not merely unused here but unreachable, which is the
 * only version of this rule that survives someone editing the file later. What it does
 * carry changes when the agent *starts* or *finishes* something, a handful of times in a
 * session, which is the cost the standing block is worth paying.
 *
 * A met objective is not injected: it is finished, and restating it for the rest of the
 * session costs context on every call and buys nothing. The widget keeps the `✓`.
 */
export function formatInjection(plan: Plan): string {
  const body: string[] = [];

  if (plan.objective && plan.objective.status !== "met") {
    body.push(`${OBJECTIVE_MARKERS.active} ${plan.objective.objective}`);
    if (plan.objective.criteria) body.push(`  met when: ${plan.objective.criteria}`);
  }

  const active = activeItem(plan);
  if (active) {
    body.push(`${ITEM_MARKERS.active} in progress: ${active.content}`);
    if (active.approach) body.push(`  approach: ${active.approach}`);
  }

  if (body.length === 0) return "";
  return injectionBlock("plan", "plan · objective and current work", body.join("\n"));
}

/** Log lines, most recent first: `✕ content — reason`. */
function logLines(log: LogEntry[], limit: number): string[] {
  return log
    .slice(-limit)
    .reverse()
    .map((e) => clip(`${OUTCOME_MARKERS[e.outcome]} ${e.content} — ${e.note}`, 120));
}

/** How many log entries the resume block carries. Enough to be a memory, bounded so it cannot become the context. */
const LOG_BUDGET = 20;

/**
 * The full picture, re-injected on `session_start` and after `session_compact`.
 *
 * This is the only place the **log** reaches the agent, and it is the reason the log
 * exists. A `finish`/`drop` tool result echoes the entry at the moment it is written, but
 * that echo lives in the transcript and dies at compaction — which is precisely when the
 * agent forgets that it already abandoned something and proposes it again. Dropped entries
 * come first and always: "we tried this and here is why we stopped" is the expensive thing
 * to relearn, while a completed item mostly speaks for itself.
 */
export function formatResume(plan: Plan): string {
  const body: string[] = [];

  if (plan.objective) {
    body.push(`${OBJECTIVE_MARKERS[plan.objective.status]} ${plan.objective.objective}`);
    if (plan.objective.criteria) body.push(`  met when: ${plan.objective.criteria}`);
  }

  if (plan.items.length > 0) {
    body.push("", "open:");
    for (const item of plan.items) {
      body.push(clip(`${item.id}. ${ITEM_MARKERS[item.status]} ${item.content}`, 120));
      if (item.approach) body.push(clip(`     approach: ${item.approach}`, 120));
      for (const step of item.steps ?? []) {
        body.push(clip(`     ${stepMarker(step)} ${step.content}`, 120));
      }
    }
  }

  const dropped = plan.log.filter((e) => e.outcome === "dropped");
  const done = plan.log.filter((e) => e.outcome === "done");
  if (dropped.length > 0) {
    body.push("", "abandoned earlier — do not re-propose these without new information:");
    body.push(...logLines(dropped, LOG_BUDGET));
  }
  if (done.length > 0) {
    body.push("", `resolved (${done.length}):`);
    body.push(...logLines(done, LOG_BUDGET));
  }

  if (body.length === 0) return "";
  return injectionBlock("plan", "plan · restored after a session reset", body.join("\n"));
}
