import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoItem } from "pi-shared";
import { loadConfig, saveConfig } from "./src/config.ts";
import { renderTodos, formatInjection } from "./src/render.ts";
import { pendingReminder, nudgeAction } from "./src/nudge.ts";
import { appendState, restoreState } from "./src/persist.ts";
import { buildTodoTool } from "./src/tool.ts";
import { buildTodoCommand } from "./src/command.ts";

/**
 * pi-todo — the agent's task list.
 *
 * Registers `todo_write` (full-list replace, echoes the list), renders a live
 * widget, re-injects the list on session start / after compaction, nudges on
 * settle per mode, and emits `todo:updated` / `todo:task-complete`.
 *
 * Build spec: docs/superpowers/plans/2026-07-20-pi-todo.md
 */
export default function piTodo(pi: ExtensionAPI): void {
  let todos: TodoItem[] = [];

  pi.registerTool(
    buildTodoTool({
      getState: () => todos,
      setState: (t) => {
        todos = t;
      },
      emit: (event, data) => pi.events.emit(event, data),
      persist: (t) => appendState(pi, t),
    }),
  );

  const command = buildTodoCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
  });
  pi.registerCommand(command.name, command.options);

  // Restore prior state and re-surface it to both the user (widget) and the agent
  // (context injection) whenever the context resets.
  const restoreAndInject = (ctx: ExtensionContext) => {
    todos = restoreState(ctx);
    ctx?.ui?.setWidget?.("todo", todos.length > 0 ? renderTodos(todos) : undefined);
    // One-shot print/JSON mode (no UI): skip injection — a queued message would
    // stall Pi's exit waiting for a "next prompt" that never arrives.
    if (!ctx.hasUI) return;
    const block = formatInjection(todos);
    if (block) {
      pi.sendMessage({ customType: "pi-todo", content: block, display: false }, { deliverAs: "nextTurn" });
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    restoreAndInject(ctx);
  });
  pi.on("session_compact", async (_event, ctx) => {
    restoreAndInject(ctx);
  });

  // Nudge on settle: notify = passive reminder next turn; block = auto-continue
  // (guarded so it can't loop forever without progress).
  let lastNudgeSig = "";
  let noProgressNudges = 0;
  pi.on("agent_settled", async (_event, ctx) => {
    const reminder = pendingReminder(todos);
    const action = nudgeAction(loadConfig().mode, ctx.hasUI, reminder !== null);
    if (action === "none" || reminder === null) {
      lastNudgeSig = "";
      noProgressNudges = 0;
      return;
    }
    if (action === "continue") {
      // block mode: auto-continue, guarded so it can't loop without progress.
      const sig = JSON.stringify(todos);
      if (sig === lastNudgeSig) {
        noProgressNudges += 1;
        if (noProgressNudges >= 2) return;
      } else {
        noProgressNudges = 0;
      }
      lastNudgeSig = sig;
      pi.sendMessage(
        { customType: "pi-todo", content: reminder, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } else {
      // notify mode: passive reminder on the next prompt.
      pi.sendMessage({ customType: "pi-todo", content: reminder, display: true }, { deliverAs: "nextTurn" });
    }
  });
}
