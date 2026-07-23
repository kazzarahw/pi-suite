import { injectionBlock, type TodoItem, type TodoStatus } from "pi-shared";

const MARKERS: Record<TodoStatus, string> = {
  pending: "▢",
  in_progress: "◐",
  done: "▣",
};

/** Widget lines: one marked line per todo, in list order. */
export function renderTodos(todos: TodoItem[]): string[] {
  return todos.map((t) => `${MARKERS[t.status]} ${t.content}`);
}

/** The `<pi-todo>` context block for the agent, or `""` when the list is empty. */
export function formatInjection(todos: TodoItem[]): string {
  if (todos.length === 0) return "";
  return injectionBlock("todo", "todo · current task list", renderTodos(todos).join("\n"));
}
