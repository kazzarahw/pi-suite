import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-todo — the agent's task list.
 *
 * Registers one `todo_write` tool (replace the whole list, Claude-Code style; the
 * result echoes the list back), renders a live widget, re-injects the list into
 * context on session_start/compaction, and emits `todo:updated` /
 * `todo:task-complete`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-todo.md
 */
export default function piTodo(pi: ExtensionAPI): void {
  // TODO: register `todo_write`, the widget, and the session_start/compact injection per the spec.
}
