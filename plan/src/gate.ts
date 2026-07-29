/**
 * Whether to refuse an edit — the **Interdict** half of `block`.
 *
 * `shared/mode.ts` describes two shapes for `block`: Interdict, which returns
 * `{ block: true }` so the offending action does not happen, and Insist, which triggers
 * another turn because the complaint *is* that nothing happened. Until now the Interdict
 * row was empty. pi-lens cannot fill it and its config explains why at length: the only
 * hook that can refuse is `tool_call`, which fires *before* the write, when the
 * diagnostics it would be interdicting do not exist yet.
 *
 * pi-plan is the case that inverts. What it objects to is a *precondition* of the edit —
 * that no item is active, so nothing was decomposed and no approach was committed to — and
 * a precondition is knowable exactly when `tool_call` fires. So pi-plan does both shapes at
 * once: it insists at settle and interdicts at the edit.
 *
 * The decision lives here rather than as booleans in `index.ts` for the reason
 * `lens/src/gate.ts` gives about its own policy: logic reachable only by driving two hooks
 * in the right order with the right fake context gets covered incidentally, if at all. As
 * a pure function it is a handful of one-line tests.
 */
import { EDIT_TOOLS, type Mode } from "../../shared/index.ts";
import { activeItem, type Plan } from "./state.ts";

export interface GateDecision {
  block: boolean;
  /** Why, and what to call instead. Only present when blocking. */
  reason?: string;
}

const ALLOW: GateDecision = { block: false };

/**
 * Is there a plan at all?
 *
 * **The arm condition is the whole reason this is usable.** Without it, installing pi-plan
 * would mean no edit works until the tool has been called, so every one-line session
 * becomes ceremony and the first thing any user does is turn the mode back down. An empty
 * plan is not a violated plan; it is someone who has not started one, and the settle nudge
 * already covers that case without stopping anybody's work.
 */
const armed = (plan: Plan): boolean => plan.objective !== null || plan.items.length > 0;

/**
 * Refuse an edit only when every one of these holds: the mode is `block`, the tool
 * actually writes to disk, a plan exists, and no item is active with an approach.
 *
 * The `EDIT_TOOLS` set comes from `shared/tool-input.ts` rather than being redefined here.
 * That set exists because pi-git and pi-lens once disagreed about which tools write, and a
 * third opinion is how the next silent gap gets introduced. It contains `write` and `edit`
 * and not `plan`, so this can never gate the tool that resolves it.
 *
 * **What it does not cover is a write through `bash`.** `shared/tool-input.ts` names that
 * case too, as `OPAQUE_WRITE_TOOLS`: a `sed -i`, a heredoc, a `git apply`, or a plain `>`
 * redirect changes a file without naming it in the input, which is why pi-git snapshots the
 * entire working set before bash runs rather than trying to read a path out of it. Gating it
 * here would mean one of two worse things — refusing bash wholesale, which is unusable when
 * bash is also the reads, the tests, and the git; or guessing from the command string
 * whether it writes, which fails open on the shapes that matter and fails closed on the ones
 * that do not.
 *
 * So `block` is a **discipline aid, not an enforcement guarantee**. It makes editing outside
 * the plan take a deliberate detour; it does not make it impossible. That distinction is
 * worth the paragraph: an undocumented gap reads as a promise the code does not keep, and
 * this one is a deliberate scope decision rather than an unfinished implementation.
 */
export function gateEdit(plan: Plan, mode: Mode, toolName: string): GateDecision {
  if (mode !== "block") return ALLOW;
  if (!EDIT_TOOLS.has(toolName)) return ALLOW;
  if (!armed(plan)) return ALLOW;

  const active = activeItem(plan);
  if (active && active.approach) return ALLOW;

  // An active item with no approach cannot come from `applyStart`, and `restoreState`
  // demotes one that arrives that way — so this is unreachable in practice and handled
  // anyway, because "unreachable" is a claim about today's code and this is a refusal.
  if (active && !active.approach) {
    return {
      block: true,
      reason:
        `[pi-plan] "${active.content}" is active but carries no approach, so nothing was committed to before editing. ` +
        `Call the plan tool with action "start" again for id ${active.id}, stating the approach.`,
    };
  }

  if (plan.items.length === 0) {
    return {
      block: true,
      reason:
        `[pi-plan] there is an objective but no plan under it, and nothing is active. ` +
        `Call the plan tool with action "items" to lay out the work, then action "start" with an approach before editing.`,
    };
  }

  const next = plan.items[0]!;
  return {
    block: true,
    reason:
      `[pi-plan] no item is active, so this edit is not part of any planned work. ` +
      `Call the plan tool with action "start", an id (next up is ${next.id}: "${next.content}"), and the approach you are committing to. ` +
      `Deciding the approach before editing is the point; stating it afterwards is not the same thing.`,
  };
}
