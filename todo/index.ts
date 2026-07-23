import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-todo — the agent's task list.
 *
 * Registers `todo_write` (replace the whole list, Claude-Code style) and
 * `todo_list`, renders a live widget, and emits `todo:updated` /
 * `todo:task-complete`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-todo.md
 */
export default function piTodo(pi: ExtensionAPI): void {
  // TODO: register `todo_write` / `todo_list` and the widget per the spec.
}
