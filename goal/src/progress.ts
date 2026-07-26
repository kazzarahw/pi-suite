/**
 * Todo progress, read off the bus.
 *
 * An *optional* enhancement: pi-goal subscribes to `todo:updated` and shows how the
 * tactical list is tracking against the objective. It does not care who publishes the
 * event — pi-todo does today — and with no publisher present nothing here ever runs and
 * the fragment simply never appears. There is no import between the two, only the bus.
 *
 * The payload is treated as untrusted for the same reason it is self-contained: a
 * subscriber is handed `data` and nothing else, and the publisher may not be the sibling
 * that ships today.
 */

/** How the open task list is tracking. */
export interface TodoProgress {
  done: number;
  total: number;
}

/**
 * Read `{ todos }` off a `todo:updated` payload, or `null` when there is nothing to
 * show — a malformed payload, or an empty list, which says no more than silence does.
 */
export function readProgress(data: unknown): TodoProgress | null {
  const todos = (data as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const done = todos.filter((t) => (t as { status?: unknown } | null)?.status === "done").length;
  return { done, total: todos.length };
}
