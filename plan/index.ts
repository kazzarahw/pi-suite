import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createNudgeGuard, nudgeAction, type Emitter } from "../shared/index.ts";
import { loadConfig, saveConfig } from "./src/config.ts";
import { emptyPlan, applyClear, type Plan } from "./src/state.ts";
import { renderPlan, formatInjection, formatResume } from "./src/render.ts";
import { planReminder } from "./src/nudge.ts";
import { gateEdit } from "./src/gate.ts";
import { readVerify, type VerifyState } from "./src/peers.ts";
import { appendState, restoreState } from "./src/persist.ts";
import { buildPlanTool } from "./src/tool.ts";
import { buildPlanCommand } from "./src/command.ts";

/**
 * pi-plan — the agent's plan, as a lifecycle rather than a list.
 *
 * Registers `plan` (one action enum over objective / items / add / start / step / promote /
 * finish / drop), keeps the objective and the active item in context on every call, renders
 * a live widget, restores after a fork or compaction, nudges on settle, and in `block` mode
 * refuses edits made outside any planned work. Emits `plan:objective`, `plan:met`,
 * `plan:updated`, `plan:item-done`, `plan:item-dropped`.
 */
export default function piPlan(pi: ExtensionAPI): void {
  const emit: Emitter = (event, data) => pi.events.emit(event, data);
  let plan: Plan = emptyPlan();
  /** From `verify:passed`; stays null when nothing publishes it. See src/peers.ts. */
  let verify: VerifyState | null = null;

  /**
   * Two guards, and they must stay two.
   *
   * pi-goal shipped a fixed bug that the merge would reintroduce by default: folding a
   * peer's progress into the objective's settle signature meant any task movement rearmed
   * the guard, so `block` never terminated. With the list and the objective now in **one
   * object**, `JSON.stringify(plan)` is the obvious signature and it is exactly that bug —
   * one signature over one tree, moving whenever any leaf moves.
   *
   * So the objective guard signs `plan.objective` and nothing else (a quota per
   * objective — a declaration has nothing progress-tracking could honestly measure), and
   * the item guard signs the work product, which genuinely moves as the work moves.
   */
  const objectiveGuard = createNudgeGuard();
  const itemGuard = createNudgeGuard();
  /** Bounds the Interdict half of `block`, per `shared/mode.ts`: no escalation without one. */
  const blockGuard = createNudgeGuard();

  const paint = (ctx: ExtensionContext): void => {
    const lines = renderPlan(plan, verify);
    ctx?.ui?.setWidget?.("plan", lines.length > 0 ? lines : undefined);
  };

  pi.registerTool(
    buildPlanTool({
      getState: () => plan,
      setState: (p) => {
        plan = p;
      },
      emit,
      persist: (p) => appendState(pi, p),
      renderContext: () => verify,
    }),
  );

  const command = buildPlanCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    getPlan: () => plan,
    clearPlan: (ctx) => {
      plan = applyClear(plan).plan;
      // Recorded, not just forgotten: the newest `plan-state` entry wins on restore, so
      // without this a fork would resurrect what the user just cleared.
      appendState(pi, plan);
      paint(ctx);
    },
    resetPlan: (ctx) => {
      plan = emptyPlan();
      verify = null;
      appendState(pi, plan);
      paint(ctx);
    },
  });
  pi.registerCommand(command.name, command.options);

  /**
   * Restore and re-surface whenever the context resets.
   *
   * The queued message is what carries the **log** — the standing injection deliberately
   * does not, and a `finish`/`drop` echo dies with the transcript it lived in. Compaction
   * is precisely when the agent forgets that it already abandoned something and proposes
   * it again, so this is the one moment the record has to be replayed.
   */
  const restoreAndInject = (ctx: ExtensionContext): void => {
    plan = restoreState(ctx);
    paint(ctx);
    // One-shot print/JSON mode (no UI): skip injection — a queued message would stall Pi's
    // exit waiting for a "next prompt" that never arrives.
    if (!ctx.hasUI) return;
    const block = formatResume(plan);
    if (block) {
      pi.sendMessage(
        { customType: "pi-plan", content: block, display: false },
        { deliverAs: "nextTurn" },
      );
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    restoreAndInject(ctx);
  });
  pi.on("session_compact", async (_event, ctx) => {
    restoreAndInject(ctx);
  });

  // Standing context: the objective and the active item ride along on every LLM call. A
  // plan that is only re-injected at session start is one the model has already drifted
  // from by the time it matters, and returning messages rather than queueing one cannot
  // stall `pi -p`. What goes in here is kept deliberately small — see src/render.ts on the
  // prompt cache.
  pi.on("context", async (event) => {
    if (loadConfig().mode === "off") return;
    const block = formatInjection(plan);
    if (!block) return;
    const injected = { role: "user" as const, content: block, timestamp: Date.now() };
    return { messages: [injected, ...event.messages] };
  });

  /**
   * The Interdict half of `block`: refuse an edit made outside any planned work.
   *
   * The decision itself is pure and lives in `src/gate.ts`. This wires it, bounds it, and
   * — per `shared/README.md`, "a hook must never break the turn it observes" — makes
   * absolutely sure a throw in here cannot fail the tool call it was only supposed to
   * inspect. A gate that crashes the edit it meant to question is worse than no gate.
   */
  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    try {
      const decision = gateEdit(plan, loadConfig().mode, event.toolName);
      if (!decision.block) return undefined;

      // The same signature twice means the last refusal achieved nothing. Rather than
      // wedging the session, give up and say so once.
      if (!blockGuard.allow(JSON.stringify(plan), loadConfig().maxBlocks)) {
        ctx?.ui?.notify?.(
          "[pi-plan] letting this edit through — blocking it again has not helped. Run /pi-plan notify to stop refusing edits.",
          "warning",
        );
        return undefined;
      }
      return { block: true, reason: decision.reason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ctx?.hasUI) ctx.ui?.notify?.(`[pi-plan] gate error: ${message}`, "error");
      else console.error(`[pi-plan] gate error: ${message}`);
      return undefined;
    }
  });

  /**
   * The Insist half: notify = passive reminder next turn; block = auto-continue the turn.
   *
   * Both guards are consulted, and which one applies depends on what the reminder is
   * about. An objective with no plan under it is a declaration problem, bounded by the
   * per-objective quota; anything item-shaped is bounded by no-progress detection against
   * the work product, at pi-todo's long-standing 2 — the first nudge plus one retry, which
   * is the *semantics* of a no-progress detector rather than a preference worth a dial.
   */
  const ITEM_NUDGE_MAX = 2;
  pi.on("agent_settled", async (_event, ctx) => {
    const cfg = loadConfig();
    const reminder = planReminder(plan, verify);
    const action = nudgeAction(cfg.mode, ctx.hasUI, reminder !== null);
    if (action === "none" || reminder === null) {
      objectiveGuard.reset();
      itemGuard.reset();
      return;
    }

    const aboutItems = plan.items.length > 0;
    const allowed = aboutItems
      ? itemGuard.allow(JSON.stringify(plan.items), ITEM_NUDGE_MAX)
      : objectiveGuard.allow(JSON.stringify(plan.objective), cfg.maxNudges);
    if (!allowed) return;

    const options =
      action === "continue"
        ? { deliverAs: "followUp" as const, triggerTurn: true }
        : { deliverAs: "nextTurn" as const };
    pi.sendMessage({ customType: "pi-plan", content: reminder, display: true }, options);
  });

  // The one optional enhancement, and pi-plan's only bus coupling: whoever publishes this
  // gets their signal folded into the readout. With no publisher the handler never runs and
  // the fragment never appears.
  //
  // It may not reach either nudge guard. If a peer's signal could rearm a quota, installing
  // pi-lens would silently change whether pi-plan's `block` mode terminates — an optional
  // enhancement must not be able to do that.
  pi.events.on("verify:passed", (data) => {
    verify = readVerify(data);
  });
}
