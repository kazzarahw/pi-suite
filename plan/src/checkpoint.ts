/**
 * The revision prompt, appended to a `plan` tool result.
 *
 * This exists because **revision is an inaction, and the suite has no shape for those at
 * the moment they happen.** `shared/mode.ts` gives `block` two: Interdict refuses an
 * action, and works on *preconditions* knowable when `tool_call` fires; Insist triggers
 * another turn, and works on *inactions* knowable only afterwards. A plan that should have
 * been revised and was not is an inaction, so on that taxonomy it is Insist-only — the
 * settle nudge, which costs a turn, is bounded by a quota, and is off entirely in `off`
 * mode.
 *
 * The way out is to stop treating revision as its own event and attach it to one the agent
 * already performs. `finish` and `drop` are the moments it has just learned something and
 * is about to consult the list again, and both already return a tool result. So the prompt
 * rides that result, which is the best surface in the extension and was carrying nothing
 * but a state echo:
 *
 * - It is unambiguously **harness output**. The settle nudge is not — `convertToLlm` drops
 *   `customType`, so it arrives as `{ role: "user" }` and reads as something the user
 *   typed, which is why `src/nudge.ts` has to prefix itself by hand.
 * - It arrives **in-band**, as the direct answer to the model's own call, at the one moment
 *   the model is definitionally reading pi-plan's words.
 * - It costs **no turn, no quota, and no mode** — it works at `off`, where the nudge and
 *   the gate are both silent.
 *
 * Dogfooding is what asked for it: across two sessions that adopted the plan fully, the
 * list was laid out once and never revised, and an item that turned out to need no work
 * was `finish`ed rather than dropped. Both are failures to reconsider, and neither had
 * anywhere to be caught.
 *
 * The wording is a **question**, following the precedent `src/nudge.ts` set for the verify
 * fragment: whether the work changed the plan is a judgement about the work, and it stays
 * the agent's to make. Naming the call to make is the part we can be certain of.
 */
import { type Plan } from "./state.ts";

/** Attribution, for the reason {@link import("./nudge.ts")} spells out at length. */
const SOURCE = "[pi-plan]";

/**
 * The actions after which the plan is worth re-reading.
 *
 * Resolutions only. `start` is the agent committing to what it already decided, and
 * `items`/`add` *are* a revision — prompting for one there would be asking a question that
 * was just answered.
 */
const REFLECTION_POINTS = new Set(["finish", "drop"]);

/**
 * What to append to this tool result, or `null` for the great majority of calls.
 *
 * Silence is the default and stays cheap: this rides every resolution, so anything longer
 * than a line becomes wallpaper, and wallpaper is how a prompt stops being read.
 */
export function checkpointFor(action: string, plan: Plan): string | null {
  if (!REFLECTION_POINTS.has(action)) return null;

  // Work remains: the question is whether it is still the right work.
  if (plan.items.length > 0) {
    const n = plan.items.length;
    return (
      `${SOURCE} ${n} item${n === 1 ? "" : "s"} still open — does what you just learned change any of them? ` +
      `Add discovered work with action "add", re-plan with action "items", or action "drop" what is no longer needed.`
    );
  }

  // The list is empty, so the only question left is the one above it. This is also the
  // only place anything asks it outside the settle nudge, and the agent that never
  // settles — one that keeps working to the end of the task — would otherwise never be
  // asked whether the objective it declared has been achieved.
  if (plan.objective && plan.objective.status !== "met") {
    return (
      `${SOURCE} nothing is open. Is "${plan.objective.objective}" achieved? ` +
      `Mark it with action "objective" and status "met", or lay out what is left with action "items".`
    );
  }

  return null;
}
