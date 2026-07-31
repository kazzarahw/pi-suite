/**
 * The one line appended to every `plan` tool result.
 *
 * Two jobs, and they are the same job at different moments: say what the legal next call
 * is, and — after a resolution, when the agent has just learned something — ask whether the
 * list still describes the work.
 *
 * **Why the tool result and not a nudge.** `shared/mode.ts` gives `block` two shapes:
 * Interdict refuses an action, and works on *preconditions* knowable when `tool_call` fires;
 * Insist triggers another turn, and works on *inactions* knowable only afterwards. A plan
 * that should have been revised and was not is an inaction, so on that taxonomy it is
 * Insist-only — the settle nudge, which costs a turn, is bounded by a quota, and is off
 * entirely in `off` mode. The way out is to stop treating this as its own event and attach
 * it to one the agent already performs. Every call returns a result, so the guidance rides
 * that:
 *
 * - It is unambiguously **harness output**. The settle nudge is not — `convertToLlm` drops
 *   `customType`, so it arrives as `{ role: "user" }` and reads as something the user
 *   typed, which is why `src/nudge.ts` has to prefix itself by hand.
 * - It arrives **in-band**, as the direct answer to the model's own call, at the one moment
 *   the model is definitionally reading pi-plan's words.
 * - It costs **no turn, no quota, and no mode** — it works at `off`, where the nudge and
 *   the gate are both silent.
 *
 * **Why it now rides every call rather than only resolutions.** The revision question was
 * here first and was the whole of this module. Dogfooding then produced a session in which
 * the agent knew the eight verbs and still could not sequence them: it ticked step 0 of an
 * empty worksheet, started a second item over an active one, called `finish` with an id,
 * and started an item it had already finished with the approach "Already done". Every one of
 * those is legal-shaped and wrong *for the current state*, and the state was the one thing
 * the result did not say anything about — it echoed the list and stopped. The list shows what
 * exists; it does not show which transition is available, and the lifecycle is the whole
 * abstraction. So the default branch names the call.
 *
 * The wording stays a **question** wherever the answer is a judgement about the work — see
 * `src/nudge.ts` on the verify fragment. Naming the call to make is the part we can be
 * certain of; whether the work changed the plan is not ours to decide.
 *
 * It is **one line**, deliberately. This rides every single call, and anything longer
 * becomes wallpaper — which is how a prompt stops being read.
 */
import { activeItem, itemLabel, type Plan } from "./state.ts";

/** Attribution, for the reason {@link import("./nudge.ts")} spells out at length. */
const SOURCE = "[pi-plan]";

/**
 * The actions after which the plan is worth re-reading.
 *
 * Resolutions only. `start` is the agent committing to what it already decided, and
 * `items`/`add` *are* a revision — prompting for one there would be asking a question that
 * was just answered. Those all fall through to {@link nextCall} instead.
 */
const REFLECTION_POINTS = new Set(["finish", "drop"]);

/**
 * The transition available from here, named as the call that performs it.
 *
 * Derived from state alone, so it cannot disagree with what the reducers will accept: each
 * branch is the precondition of exactly one verb. The order is the lifecycle read backwards,
 * matching `src/nudge.ts` — an agent with an active item does not need to be told the
 * objective is open; it needs the next transition on the item it is holding.
 */
function nextCall(plan: Plan): string {
  const active = activeItem(plan);
  if (active) {
    const steps = active.steps ?? [];
    const pending = steps.find((s) => !s.done);
    if (pending) {
      return (
        `next: "${pending.content}" is the first unticked step — tick it with action "step" (index and done) as you go, ` +
        `then action "finish" with a note when "${active.content}" is done.`
      );
    }
    // No worksheet and a fully ticked one are the same position in the lifecycle — the item
    // is resolvable — but they need different sentences, because an agent that has just been
    // refused an index against an empty worksheet needs to hear that appending is a thing.
    const worksheet =
      steps.length === 0
        ? `It has no worksheet; add one with action "step" and a "steps" array if it helps.`
        : `Every step is ticked.`;
    return (
      `next: "${active.content}" is active. ${worksheet} ` +
      `Resolve it with action "finish" and a note saying what you changed, or action "drop" with a reason if it turned out not to need doing.`
    );
  }

  if (plan.items.length > 0) {
    const up = plan.items[0]!;
    return (
      `next: nothing is active. Call action "start" with an id (next up is ${itemLabel(up)}) ` +
      `and the approach you are committing to, before you edit anything.`
    );
  }

  if (plan.objective && plan.objective.status !== "met") {
    return `next: nothing is open under "${plan.objective.objective}" — lay the work out with action "items".`;
  }

  // No objective, or one already met, and an empty list. Either way the next thing is a
  // declaration, and there is no state to ask a question about.
  return `next: set what this session is working toward with action "objective", then lay the work out with action "items".`;
}

/** What to append to this tool result. Never `null` — every call gets a line. */
export function checkpointFor(action: string, plan: Plan): string | null {
  if (!REFLECTION_POINTS.has(action)) return `${SOURCE} ${nextCall(plan)}`;

  // Work remains: the question is whether it is still the right work. The next call is named
  // alongside it, because "revise the list" and "start the next one" are both live here and a
  // resolution is the moment the choice between them is actually being made — an agent that
  // was asked only the question answered it and then started an item it had already finished.
  if (plan.items.length > 0) {
    const n = plan.items.length;
    const up = plan.items[0]!;
    return (
      `${SOURCE} ${n} item${n === 1 ? "" : "s"} still open — does what you just learned change any of them? ` +
      `Add discovered work with action "add", re-plan with action "items", or action "drop" what is no longer needed. ` +
      `Otherwise action "start" the next one (${itemLabel(up)}) with an approach.`
    );
  }

  // The list is empty, so the only question left is the one above it. This is also the
  // only place anything asks it outside the settle nudge, and the agent that never
  // settles — one that keeps working to the end of the task — would otherwise never be
  // asked whether the objective it declared has been achieved.
  if (plan.objective && plan.objective.status !== "met") {
    return (
      `${SOURCE} nothing is open. Is "${plan.objective.objective}" achieved? ` +
      `Mark it with action "objective" and status "met" — the objective text may be omitted to restate it — ` +
      `or lay out what is left with action "items".`
    );
  }

  return `${SOURCE} ${nextCall(plan)}`;
}
