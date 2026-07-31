/**
 * What to say at settle, by precedence.
 *
 * The decision of *whether* to deliver this is `nudgeAction` in `shared/nudge.ts`; what
 * counts as unfinished work, and how it is worded, is pi-plan's own — the same division
 * pi-todo and pi-goal kept before the merge.
 *
 * The precedence is the lifecycle read backwards, which is what makes each reminder
 * actionable rather than a general complaint. An agent with an active item and unticked
 * steps does not need to be told the objective is open; it needs the next step named.
 */
import { activeItem, itemLabel, type Plan } from "./state.ts";
import type { VerifyState } from "./peers.ts";

/**
 * Every reminder says who is speaking, because nothing else does.
 *
 * A settle nudge is queued with `pi.sendMessage({ customType: "pi-plan", … })`, and Pi's
 * `convertToLlm` drops `customType` on the floor: a custom message becomes
 * `{ role: "user", content }` carrying the bare text. `customType` survives only as a label
 * the *terminal* draws — the model is handed prose in the user's own voice, from the user's
 * own role, with nothing to mark it as harness output.
 *
 * That is not theoretical. In dogfooding an agent read a nudge as the next paragraph of the
 * user's message and spent a reply reasoning about the "contradiction" between them, and in
 * `block` mode it obeyed a nudge over an explicit instruction to stop — because as far as it
 * could tell, both were the user and the nudge came second.
 *
 * So the prefix is load-bearing rather than decoration, and `shared/README.md` already
 * requires it in spirit: harness output must be recognizable as harness output. `[pi-plan]`
 * is the spelling every other string this extension shows the model already uses — tool
 * failures, the gate's refusal, the give-up notice — and this was the one that did not.
 */
const SOURCE = "[pi-plan]";

/**
 * The reminder for this settle, or `null` when there is nothing to say.
 *
 * `verify` is named rather than merely counted because this is the one place the agent may
 * need to *act* on it: an objective still open while the project's checks pass is the exact
 * moment to ask whether the criteria are already satisfied. The wording puts that as a
 * question, not an instruction — passing tests are evidence about the objective, never a
 * decision about it.
 */
export function planReminder(plan: Plan, verify: VerifyState | null = null): string | null {
  const body = reminderBody(plan, verify);
  // Prefixed here rather than in each branch, so a reminder added later cannot ship
  // unattributed by forgetting to do it.
  return body === null ? null : `${SOURCE} ${body}`;
}

/** The reminder itself, by precedence. Attribution is {@link planReminder}'s job. */
function reminderBody(plan: Plan, verify: VerifyState | null): string | null {
  const active = activeItem(plan);

  // 1. Work in flight with a worksheet still open: name the next step and nothing else.
  if (active) {
    const next = (active.steps ?? []).find((s) => !s.done);
    if (next) {
      return (
        `Still working "${active.content}". Next step: "${next.content}". ` +
        `Tick it off with the plan tool (action "step") as you go, and call action "finish" with a note when the item is done.`
      );
    }
    return (
      `"${active.content}" is active and every step is ticked. ` +
      `Call the plan tool with action "finish" and a note saying what you actually changed, or action "drop" with a reason if it turned out to be unnecessary or was already done.`
    );
  }

  // 2. Work laid out but nothing entered: the decompose-before-you-commit step is missing.
  if (plan.items.length > 0) {
    const next = plan.items[0]!;
    return (
      `${plan.items.length} item(s) open and none active. Next: ${itemLabel(next)}. ` +
      `Call the plan tool with action "start", that id, and the approach you are committing to before you edit anything.`
    );
  }

  // 3. An objective with no plan under it.
  if (plan.objective && plan.objective.status !== "met") {
    const parts = [`Objective still open: "${plan.objective.objective}".`];
    if (plan.objective.criteria) parts.push(`Met when: ${plan.objective.criteria}.`);
    if (verify) parts.push(`\`${verify.cmd}\` passed — does that satisfy the criteria?`);
    parts.push(
      `Nothing is planned under it. Lay out the work with the plan tool (action "items"), ` +
        `or call action "objective" with status "met" if it is already achieved.`,
    );
    return parts.join(" ");
  }

  // 4. Nothing open, or the objective is met. Silence is the correct output.
  return null;
}
