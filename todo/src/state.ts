import type { TodoItem, TodoStatus } from "pi-shared";

export type { TodoItem, TodoStatus };

/** A todo as supplied by the agent: `id` optional (assigned/preserved by us). */
export interface TodoInput {
  id?: string;
  content: string;
  status: TodoStatus;
}

/** Result of a full-list replace. */
export interface ApplyResult {
  todos: TodoItem[];
  /** Items that transitioned to `done` in this write (drives `todo:task-complete`). */
  newlyCompleted: TodoItem[];
}

/**
 * Full-list replace reducer (Claude-Code TodoWrite model). Assigns stable ids to
 * new items, preserves ids for items matched by explicit id or by content, and
 * reports items newly transitioned to `done`. Pure and deterministic.
 */
export function applyWrite(prev: TodoItem[], incoming: TodoInput[]): ApplyResult {
  const prevStatusById = new Map(prev.map((t) => [t.id, t.status]));
  const claimed = new Set<string>();

  const todos: TodoItem[] = incoming.map((inc, index) => {
    let id = inc.id;
    if (!id) {
      const match = prev.find((p) => p.content === inc.content && !claimed.has(p.id));
      id = match ? match.id : makeId(index, inc.content);
    }
    claimed.add(id);
    return { id, content: inc.content, status: inc.status };
  });

  const newlyCompleted = todos.filter(
    (t) => t.status === "done" && prevStatusById.get(t.id) !== "done",
  );
  return { todos, newlyCompleted };
}

/** Deterministic id from content + position (no clock, so tests stay reproducible). */
function makeId(index: number, content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return `t${index}_${(hash >>> 0).toString(36)}`;
}
