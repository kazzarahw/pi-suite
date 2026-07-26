import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNudgeGuard, nudgeAction } from "../shared/index.ts";
import { loadConfig, saveConfig } from "./src/config.ts";
import { readProgress, type TodoProgress } from "./src/progress.ts";
import { renderGoal, formatInjection, type Context } from "./src/render.ts";
import { goalReminder } from "./src/nudge.ts";
import { appendState, restoreState } from "./src/persist.ts";
import { buildGoalTool } from "./src/tool.ts";
import { buildGoalCommand } from "./src/command.ts";
import type { Goal } from "./src/state.ts";

/**
 * pi-goal — the session's north-star.
 *
 * Registers `goal_set` (one objective, full replace), keeps it in context on every LLM
 * call so it cannot fall out of the window, renders it as a widget, restores it after a
 * fork or compaction, and in `block` mode auto-continues a bounded number of times. Emits
 * `goal:set` / `goal:met`.
 */
export default function piGoal(pi: ExtensionAPI): void {
  let goal: Goal | null = null;
  /**
   * Turns since the objective was set. In memory on purpose: persisting it would mean
   * either appending a session entry every turn, or reading a stale count back after a
   * fork and reporting a negative age. A restore starts it at zero, and the render says
   * nothing at zero rather than claiming the objective is new.
   */
  let turnsSinceSet = 0;
  /** From `todo:updated`; stays null when nothing publishes it. See src/progress.ts. */
  let progress: TodoProgress | null = null;
  const guard = createNudgeGuard();

  const renderContext = (): Context => ({ turns: turnsSinceSet, progress });
  const paint = (ctx: ExtensionContext): void => {
    ctx?.ui?.setWidget?.("goal", goal ? renderGoal(goal, renderContext()) : undefined);
  };

  pi.registerTool(
    buildGoalTool({
      getState: () => goal,
      setState: (g) => {
        // Only a *real* change restarts the age, and nothing here touches the guard.
        //
        // A `goal_set` that rewrites the objective it already had is a no-op the agent
        // makes routinely — the nudge below literally asks it to restate the goal, and
        // carrying omitted fields forward is what makes that write byte-identical. An
        // unconditional `guard.reset()` here meant the nudge rearmed the guard that
        // permitted the next nudge, so `block` never terminated. The guard needs no
        // reset at all: `allow()` compares signatures, so a genuinely changed objective
        // rearms it by itself and an unchanged one correctly stays exhausted.
        if (JSON.stringify(g) !== JSON.stringify(goal)) turnsSinceSet = 0;
        goal = g;
      },
      emit: (event, data) => pi.events.emit(event, data),
      persist: (g) => appendState(pi, g),
      renderContext,
    }),
  );

  const command = buildGoalCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    getGoal: () => goal,
    clearGoal: (ctx) => {
      goal = null;
      turnsSinceSet = 0;
      guard.reset();
      // Recorded, not just forgotten: the newest `goal-state` entry wins on restore, so
      // without this a fork would resurrect the objective the user just cleared.
      appendState(pi, null);
      paint(ctx);
    },
  });
  pi.registerCommand(command.name, command.options);

  // Restore the objective and repaint whenever the context resets. No message is queued
  // here — the `context` hook below re-injects on the next call regardless, which is
  // also why this needs no `hasUI` guard.
  const restore = (ctx: ExtensionContext): void => {
    goal = restoreState(ctx);
    // The restored objective's age is genuinely unknown, so zero is honest. The guard is
    // left alone for the same reason as in `setState`: compaction restoring the *same*
    // objective must not hand `block` a fresh quota.
    turnsSinceSet = 0;
    paint(ctx);
  };
  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });
  pi.on("session_compact", async (_event, ctx) => {
    restore(ctx);
  });

  // Standing context: the objective rides along on every LLM call. A north-star that is
  // only re-injected at session start is one the model has already drifted from by the
  // time it matters, and returning messages rather than queueing one cannot stall `pi -p`.
  pi.on("context", async (event) => {
    if (loadConfig().mode === "off") return;
    const block = formatInjection(goal);
    if (!block) return;
    const injected = { role: "user" as const, content: block, timestamp: Date.now() };
    return { messages: [injected, ...event.messages] };
  });

  // Age the objective and repaint. The repaint is what makes the widget's annotation
  // live: the turn count changes here, and `todo:updated` arrives on a bus callback that
  // has no ExtensionContext and so cannot paint for itself.
  pi.on("turn_end", async (_event, ctx) => {
    if (!goal) return;
    turnsSinceSet += 1;
    // The count still advances when off, so turning the dial back up reports the real
    // age — but nothing is painted. A widget echoing a tool result is fine in `off`
    // (pi-todo does it); a widget this hook animates on its own would be the automatic
    // behavior `off` exists to stop.
    if (loadConfig().mode !== "off") paint(ctx);
  });

  // Settle: notify = passive reminder next turn; block = auto-continue the turn. Both
  // are bounded by the same guard.
  //
  // The signature is pi-goal's OWN state and nothing else. Folding `progress` in — a
  // peer's state, arriving on the bus — meant any todo movement counted as progress and
  // rearmed the guard, so an agent working the list could keep `block` triggering turns
  // indefinitely, and installing pi-todo silently changed pi-goal's termination
  // property. An optional enhancement must not be able to do that.
  //
  // `notify` is guarded for a different reason: a queued custom message becomes a
  // permanent `user` message in the transcript, so an unbounded reminder-per-settle
  // would stack duplicates of a line the standing injection already carries, for the
  // rest of the session.
  pi.on("agent_settled", async (_event, ctx) => {
    const cfg = loadConfig();
    const reminder = goalReminder(goal, progress);
    const action = nudgeAction(cfg.mode, ctx.hasUI, reminder !== null);
    if (action === "none" || reminder === null) {
      guard.reset();
      return;
    }
    if (!guard.allow(JSON.stringify(goal), cfg.maxNudges)) return;
    const options =
      action === "continue"
        ? { deliverAs: "followUp" as const, triggerTurn: true }
        : { deliverAs: "nextTurn" as const };
    pi.sendMessage({ customType: "pi-goal", content: reminder, display: true }, options);
  });

  // An optional enhancement, and the only coupling: whoever publishes `todo:updated`
  // gets their progress folded into the objective's readout. With no publisher the
  // handler never runs and the fragment never appears.
  pi.events.on("todo:updated", (data) => {
    progress = readProgress(data);
  });
}
