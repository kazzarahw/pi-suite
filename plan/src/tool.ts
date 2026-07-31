import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateForAgent, type Emitter } from "../../shared/index.ts";
import { renderToolCall } from "../../shared/tool-render.ts";
import {
  OBJECTIVE_STATUSES,
  applyAdd,
  applyDrop,
  applyFinish,
  applyItems,
  applyObjective,
  applyPromote,
  applyStart,
  applyStep,
  type ObjectiveInput,
  type ObjectiveStatus,
  type Plan,
} from "./state.ts";
import { renderPlan } from "./render.ts";
import { checkpointFor } from "./checkpoint.ts";
import type { VerifyState } from "./peers.ts";

/**
 * The verbs, in lifecycle order.
 *
 * Nouns (`objective`, `items`) replace state wholesale; verbs (`add`, `start`, `step`,
 * `promote`, `finish`, `drop`) act on the list or on one item. `start` and `drop` take an
 * `id` because they name an item; `step`, `promote`, and `finish` take none, because there
 * is only ever one active item — which is the constraint the whole extension is built on,
 * showing through in the shape of the call.
 *
 * `add` sits next to `items` because it is the same intent at a lower price: `items`
 * re-plans, `add` records something discovered. See `applyAdd` on why the difference is
 * worth an action.
 */
const ACTIONS = [
  "objective",
  "items",
  "add",
  "start",
  "step",
  "promote",
  "finish",
  "drop",
] as const;
type Action = (typeof ACTIONS)[number];

const parameters = Type.Object({
  action: StringEnum(ACTIONS, {
    description:
      "objective (set the session's goal) | items (replace the whole open list — re-planning) | add (append work you just discovered, without re-sending the list) | start (activate one item, with an approach) | step (tick or add worksheet steps) | promote (turn a step into its own item) | finish (resolve the active item as work you did) | drop (abandon an item that turned out to be unnecessary or was already done, with a reason).",
  }),
  objective: Type.Optional(
    Type.String({
      description:
        "For 'objective': the single overarching outcome this session is working toward, in one sentence. Omit it to restate the objective already recorded — that is how you mark the current one met without repeating its text.",
    }),
  ),
  criteria: Type.Optional(
    Type.String({
      description:
        "For 'objective': how you will know it is met. Omit if it speaks for itself; omitting it when restating the same objective keeps whatever was already recorded.",
    }),
  ),
  status: Type.Optional(
    StringEnum(OBJECTIVE_STATUSES, {
      description:
        "For 'objective': 'active' while work continues, 'met' once achieved. Defaults to active for a new objective, and to the current status when restating the existing one.",
    }),
  ),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        content: Type.String({ description: "What the item is, in one line." }),
        id: Type.Optional(
          Type.String({ description: "Existing item id to preserve; omit for new items." }),
        ),
      }),
      {
        description:
          "For 'items': the COMPLETE list of OPEN work — it replaces the previous list. Resolved items are not in it and must not be re-sent. The active item may not be omitted: finish or drop it instead. For 'add': only the new items, appended to what is already open — prefer this when you discovered work rather than re-planning. Every item is work still to be done, phrased as the change you will make ('add a test for boundLimit'), never a finding, a status, or a note about work already finished — those belong in the 'note' on finish. If it cannot be started, it is not an item.",
      },
    ),
  ),
  id: Type.Optional(
    Type.String({
      description:
        "For 'start' and 'drop': which open item — its id, or its exact content if that is easier to quote. 'finish' takes no id: it always resolves the one active item. Passing one that names a different item is refused rather than obeyed.",
    }),
  ),
  approach: Type.Optional(
    Type.String({
      description:
        "For 'start': how you intend to do this item, decided BEFORE you begin. Required — committing to an approach is what starting an item means.",
    }),
  ),
  steps: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "For 'start', the initial worksheet; for 'step', more steps to append. Scratch work — it is discarded when the item resolves, so a step that turns out to matter should be promoted.",
    }),
  ),
  index: Type.Optional(
    Type.Integer({
      description:
        "For 'step' (with `done`) and 'promote': which worksheet step, zero-based. Only steps that exist can be ticked — an item started without `steps` has an empty worksheet, so append some first.",
    }),
  ),
  done: Type.Optional(
    Type.Boolean({ description: "For 'step': tick the step at `index` (true) or untick it (false)." }),
  ),
  note: Type.Optional(
    Type.String({
      description:
        "For 'finish': what you actually changed, concretely — what you edited and how you know it worked. Required; it is what survives the worksheet. If you cannot name something you changed, this was not a finish: use 'drop' instead and say why.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description:
        "For 'drop': why this is being abandoned — it turned out to be unnecessary, was already done before you got there, or proved to be the wrong approach. Required — an item dropped without one is indistinguishable from one silently forgotten.",
    }),
  ),
});
type PlanParams = Static<typeof parameters>;

export interface PlanToolDeps {
  getState: () => Plan;
  setState: (plan: Plan) => void;
  emit: Emitter;
  persist: (plan: Plan) => void;
  /** Read *after* `setState`, so the widget it paints reflects this call. */
  renderContext: () => VerifyState | null;
}

/**
 * Each action's required fields, checked here rather than by the schema.
 *
 * This is what the one-tool-per-extension surface costs, and `shared/README.md` says to pay
 * it deliberately: the actions need disjoint fields, so every one has to be optional in the
 * schema and the provider can no longer reject a malformed call on our behalf. Throwing is
 * the mechanism — Pi sets `isError` only when `execute` throws — and naming every missing
 * field at once beats one round-trip per field. Copied in shape from
 * `memory/src/tools.ts:requireWriteFields`, which is where the suite settled this.
 */
const REQUIRED: Record<Action, ReadonlyArray<keyof PlanParams>> = {
  objective: ["objective"],
  items: ["items"],
  add: ["items"],
  start: ["id", "approach"],
  step: [], // disjunctive — checked below
  promote: ["index"],
  finish: ["note"],
  drop: ["id", "reason"],
};

function requireFields(params: PlanParams, plan: Plan): void {
  const action = params.action as Action;
  // Restating the objective already on record does not have to repeat it.
  //
  // `applyObjective` carries every omitted field forward across a restatement — that is
  // the documented behaviour, and marking one met is named in its comment as the common
  // second call. This check then demanded the objective text anyway, so the cheap call the
  // reducer was built for was the one the tool refused. A dogfooded session hit it exactly:
  // `objective` with `status: "met"` was rejected, and the agent resent the full sentence
  // verbatim to say a single word. The text is required only when there is nothing to
  // restate.
  const optional = action === "objective" && plan.objective !== null ? new Set(["objective"]) : null;
  const missing = REQUIRED[action].filter((k) => {
    if (optional?.has(k)) return false;
    const v = params[k];
    return v === undefined || v === "";
  });
  if (missing.length > 0) {
    throw new Error(`[pi-plan] action "${action}" requires ${missing.join(", ")}.`);
  }
  // `step` is the one action with a genuine either/or, so it cannot be a field list.
  if (action === "step") {
    const ticking = params.index !== undefined && params.done !== undefined;
    const appending = Array.isArray(params.steps) && params.steps.length > 0;
    if (!ticking && !appending) {
      throw new Error(
        `[pi-plan] action "step" requires either index and done (to tick a step) or steps (to append).`,
      );
    }
  }
}

/**
 * The interesting half of a plan call, as one line: `start 2`, `finish`, `4 items`.
 * Pure, so the wording is testable without a terminal.
 */
export function describeCall(params: PlanParams): string {
  switch (params.action as Action) {
    case "objective":
      return params.status === "met" && params.objective
        ? `${params.objective} (met)`
        : (params.objective?.trim() ?? "objective");
    case "items": {
      const n = params.items?.length ?? 0;
      return n === 0 ? "clear the list" : `${n} item${n === 1 ? "" : "s"}`;
    }
    case "add": {
      const n = params.items?.length ?? 0;
      return `+${n} item${n === 1 ? "" : "s"}`;
    }
    case "start":
      return `start ${params.id ?? ""}`.trim();
    case "step":
      return params.steps?.length ? `+${params.steps.length} steps` : `step ${params.index ?? ""}`.trim();
    case "promote":
      return `promote step ${params.index ?? ""}`.trim();
    case "finish":
      return "finish";
    case "drop":
      return `drop ${params.id ?? ""}`.trim();
  }
}

/** Build the `plan` tool: one action enum over the whole lifecycle. */
export function buildPlanTool(deps: PlanToolDeps) {
  return {
    name: "plan",
    label: "Plan",
    description:
      "Plan and track multi-step work as a strict lifecycle. Call it BEFORE you start working — as soon as the task looks like three or more distinct steps, spans more than one file, or the user asked for several things at once. Skip it for a single obvious edit, a question, or a one-line fix. Set the session objective with 'objective'. Lay out the open work with 'items' (send the COMPLETE open list; it replaces the previous one). The list is meant to be revised as you learn, not honored as written: call 'add' the moment you discover work you did not know about — it appends, so it costs one line — and 'items' again when the shape of what is left has actually changed. Before editing anything, 'start' one item with the approach you are committing to — exactly one item is active at a time. Track scratch work on that item with 'step', and 'promote' a step that turns out to deserve its own item. Resolve it with 'finish' and a note saying what you actually changed, or 'drop' it with a reason — an item you did not have to do is dropped, never finished. Resolved work leaves the list and is recorded in the log.",
    promptSnippet:
      "For work of three or more steps: set an objective, list the work, start one item with an approach before editing, revise the list as you learn, and finish or drop each item explicitly.",
    parameters,
    async execute(
      _toolCallId: string,
      params: PlanParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ plan: Plan }>> {
      const action = params.action as Action;
      const prev = deps.getState();
      requireFields(params, prev);
      let next: Plan;

      switch (action) {
        case "objective": {
          // Omitted means "the one already recorded" — see `requireFields`, which is what
          // permits the omission, and `applyObjective`, which carries the rest forward.
          const objective = (params.objective ?? prev.objective!.objective).trim();
          if (!objective) throw new Error("[pi-plan] objective must not be blank");
          const incoming: ObjectiveInput = { objective };
          const criteria = params.criteria?.trim();
          if (criteria) incoming.criteria = criteria;
          if (params.status) incoming.status = params.status as ObjectiveStatus;

          const result = applyObjective(prev, incoming);
          next = result.plan;
          const payload: { objective: string; criteria?: string } = { objective };
          if (next.objective!.criteria) payload.criteria = next.objective!.criteria;
          deps.emit("plan:objective", payload);
          if (result.newlyMet) deps.emit("plan:met", { objective });
          break;
        }
        case "items": {
          next = applyItems(prev, params.items!).plan;
          deps.emit("plan:updated", { items: next.items });
          break;
        }
        case "add": {
          next = applyAdd(prev, params.items!).plan;
          deps.emit("plan:updated", { items: next.items });
          break;
        }
        case "start": {
          next = applyStart(prev, params.id!, params.approach!, params.steps).plan;
          deps.emit("plan:updated", { items: next.items });
          break;
        }
        case "step": {
          const edit =
            params.index !== undefined && params.done !== undefined
              ? { index: params.index, done: params.done }
              : { steps: params.steps! };
          next = applyStep(prev, edit).plan;
          deps.emit("plan:updated", { items: next.items });
          break;
        }
        case "promote": {
          next = applyPromote(prev, params.index!).plan;
          deps.emit("plan:updated", { items: next.items });
          break;
        }
        case "finish": {
          // `params.id` is passed to be *checked*, not to select — see `applyFinish`, which
          // dropped it on the floor and filed the active item under another item's note.
          const result = applyFinish(prev, params.note!, params.id);
          next = result.plan;
          deps.emit("plan:item-done", { content: result.entry.content, note: result.entry.note });
          deps.emit("plan:updated", { items: next.items });
          break;
        }
        case "drop": {
          const result = applyDrop(prev, params.id!, params.reason!);
          next = result.plan;
          deps.emit("plan:item-dropped", {
            content: result.entry.content,
            reason: result.entry.note,
          });
          deps.emit("plan:updated", { items: next.items });
          break;
        }
      }

      deps.setState(next);
      deps.persist(next);

      const lines = renderPlan(next, deps.renderContext());
      ctx?.ui?.setWidget?.("plan", lines.length > 0 ? lines : undefined);
      // Plain text, per shared/README.md: Pi's default renderResult prints it verbatim, so
      // markdown and `<pi-plan>` tags would reach the transcript as literal characters.
      const body = lines.length > 0 ? lines.join("\n") : "(plan is empty)";
      // The result is also where the lifecycle is taught: one line naming the transition
      // that is legal from here, and after a resolution asking whether the list still
      // describes the work — see src/checkpoint.ts for why this surface and not a nudge.
      // Blank-line separated so the state echo stays readable as itself.
      const checkpoint = checkpointFor(action, next);
      const echoed = checkpoint ? `${body}\n\n${checkpoint}` : body;
      // Bounded, per `shared/README.md`: this echo is one line per open item plus one per
      // worksheet step, all of it agent-authored, and it is returned on every single call.
      // `keep: "tail"` because the revision prompt is the part that asks for something, and
      // dropping the question to keep the list would invert what the result is for.
      const text = truncateForAgent(echoed, { label: "plan", keep: "tail" });
      return { content: [{ type: "text", text }], details: { plan: next } };
    },
    renderCall(args: PlanParams, theme: Theme, context?: { lastComponent?: unknown }) {
      return renderToolCall("plan", describeCall(args), theme, context?.lastComponent);
    },
  };
}
