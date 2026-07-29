/**
 * The universal enforcement dial.
 *
 * Every automation-capable extension exposes this same three-level `mode`. What each
 * level *means* is fixed; extensions may add domain-specific sub-flags, but never
 * redefine the levels.
 *
 * ## What `block` means, precisely
 *
 * `off` and `notify` are unambiguous. `block` is the level worth stating carefully,
 * because it takes two shapes depending on whether the extension has an action to
 * block — and this file previously described only the first, while two of the three
 * extensions that implement it did the second.
 *
 * | Shape | Extensions | Behavior |
 * |---|---|---|
 * | **Interdict** | pi-plan | the extension observes an action it can refuse, so `block` returns `{ block: true }` and the action does not happen |
 * | **Insist** | pi-lens, pi-plan | the extension observes *inaction* — unfinished work at `agent_settled` — so `block` triggers another turn, bounded by a nudge guard |
 *
 * They are not opposites by accident: both are "the strongest thing this extension can
 * do to make the agent deal with what it found". An extension with a blockable action
 * interdicts it; one whose complaint is that nothing happened cannot interdict
 * anything, so it insists instead. What unites them, and what a user setting the dial
 * is choosing, is *escalation from telling to compelling*.
 *
 * **One extension may do both**, and pi-plan is the first that does. The two shapes are
 * decided by what an extension is looking at, not by which box it belongs in: pi-plan
 * interdicts an edit made with nothing active (a *precondition*, knowable exactly when
 * `tool_call` fires) and insists at settle when the plan has stalled (an *inaction*,
 * knowable only afterwards). pi-lens can only insist, and its config explains why: the
 * diagnostics it would interdict do not exist until after the write it would have to
 * refuse.
 *
 * The one rule every shape obeys: `block` never acts without a bound. pi-lens gates on
 * a verify gate it consumes; pi-plan goes through `createNudgeGuard` for both halves,
 * with separate guards so exhausting one does not exhaust the other. An unbounded
 * `block` is a loop, since the agent that provoked it may never resolve it.
 *
 * Extensions with no blockable action *and* nothing to insist on collapse `block` to
 * `notify` — pi-git (checkpointing is invisible) and pi-memory (writes are not gated).
 * Each says so in its own README.
 */

/** The three enforcement levels, shared by every automation-capable extension. */
export type Mode = "off" | "notify" | "block";

/**
 * Runtime list of the modes, in order. Feed into `StringEnum(MODES)` when
 * building a tool/config schema so the wire enum stays in sync with {@link Mode}.
 */
export const MODES = ["off", "notify", "block"] as const;

/** The default when a mode is unset: auto-run + surface feedback, never blocks. */
export const DEFAULT_MODE: Mode = "notify";
