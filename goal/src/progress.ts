/**
 * Peer signals, read off the bus.
 *
 * Both are *optional* enhancements: pi-goal subscribes to `todo:updated` and
 * `verify:passed` to show how the work is tracking against the objective. It does not
 * care who publishes them — pi-todo and pi-lens do today — and with no publisher present
 * nothing here runs and the fragment simply never appears. There is no import in either
 * direction, only the bus.
 *
 * Payloads are treated as untrusted for the same reason they are self-contained: a
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

/** The project's checks passed, and what command said so. */
export interface VerifyState {
  cmd: string;
}

/**
 * Read a `verify:passed` payload.
 *
 * `goal.criteria` is literally "how you will know the objective is met", and a passing
 * test/build command is the strongest evidence available for that — so pi-goal surfaces
 * it, in the widget and in the settle reminder.
 *
 * It never marks the objective **met**. Whether passing checks satisfy *this* objective
 * is a judgement about intent, which the agent makes with `goal({ status: "met" })`.
 * An extension that decided it from a green test run would be answering a different
 * question than the one the goal asked, and closing it on the agent's behalf.
 *
 * The payload's `cwd` is deliberately ignored rather than compared: pi-goal only
 * displays this, and both extensions resolve their cwd from the same session, so a
 * `verify:passed` reaching this handler is by construction about this session's project.
 * Latching a cwd to check it against is the pattern pi-memory removed for good reason.
 */
export function readVerify(data: unknown): VerifyState | null {
  const cmd = (data as { cmd?: unknown } | undefined)?.cmd;
  return typeof cmd === "string" && cmd.length > 0 ? { cmd } : null;
}
