import type { TodoItem } from "../../shared/index.ts";

/**
 * A "keep going" reminder when work remains, or `null` when the list is empty or
 * fully done. Names the in-progress item (or the first pending one) as the next step.
 */
export function pendingReminder(todos: TodoItem[]): string | null {
  const active = todos.filter((t) => t.status !== "done");
  if (active.length === 0) return null;
  const next = todos.find((t) => t.status === "in_progress") ?? active[0]!;
  return `${active.length} todo(s) still open. Next: "${next.content}". Keep going and update the list with the todo tool as you progress.`;
}
