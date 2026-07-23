import type { Mode, TodoItem } from "pi-shared";

/**
 * A "keep going" reminder when work remains, or `null` when the list is empty or
 * fully done. Names the in-progress item (or the first pending one) as the next step.
 */
export function pendingReminder(todos: TodoItem[]): string | null {
  const active = todos.filter((t) => t.status !== "done");
  if (active.length === 0) return null;
  const next = todos.find((t) => t.status === "in_progress") ?? active[0]!;
  return `${active.length} todo(s) still open. Next: "${next.content}". Keep going and update the list with todo_write as you progress.`;
}

/** What the settle hook should do. `remind` = passive; `continue` = auto-run the agent. */
export type NudgeAction = "none" | "remind" | "continue";

/**
 * Decide the settle-time nudge. Critically returns `"none"` when there is no
 * interactive UI (`-p`/JSON one-shot mode): injecting a message there queues work
 * for a "next prompt" that never comes and stalls Pi's exit.
 */
export function nudgeAction(mode: Mode, hasUI: boolean, hasPending: boolean): NudgeAction {
  if (!hasUI || mode === "off" || !hasPending) return "none";
  return mode === "block" ? "continue" : "remind";
}
