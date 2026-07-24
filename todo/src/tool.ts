import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { TODO_STATUSES, type TodoItem } from "pi-shared";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyWrite, type TodoInput } from "./state.ts";
import { renderTodos } from "./render.ts";

const parameters = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "The task description." }),
      status: StringEnum(TODO_STATUSES, {
        description: "Task status: pending, in_progress, or done.",
      }),
      id: Type.Optional(
        Type.String({ description: "Existing item id to preserve; omit for new items." }),
      ),
    }),
    {
      description:
        "The COMPLETE todo list. Replaces the previous list entirely — send every item each call.",
    },
  ),
});
type TodoWriteParams = Static<typeof parameters>;

/** Dependencies the tool needs; `ctx.ui` comes from the execute `ctx`, not here. */
export interface TodoDeps {
  getState: () => TodoItem[];
  setState: (todos: TodoItem[]) => void;
  emit: (event: string, data: unknown) => void;
  persist: (todos: TodoItem[]) => void;
}

/** Build the `todo_write` tool: full-list replace, echoes the list, emits events. */
export function buildTodoTool(deps: TodoDeps) {
  return {
    name: "todo_write",
    label: "Todo Write",
    description:
      "Create or update the task list for the current multi-step work. Send the COMPLETE list every call (it replaces the previous list). Mark an item in_progress when you start it and done when you finish. Returns the updated list.",
    promptSnippet: "Plan and track multi-step work; replace the whole todo list each call.",
    parameters,
    async execute(
      _toolCallId: string,
      params: TodoWriteParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ todos: TodoItem[] }>> {
      const { todos, newlyCompleted } = applyWrite(deps.getState(), params.todos as TodoInput[]);
      deps.setState(todos);
      deps.persist(todos);
      deps.emit("todo:updated", { todos });
      for (const done of newlyCompleted) {
        deps.emit("todo:task-complete", { task: done.content });
      }
      ctx?.ui?.setWidget?.("todo", todos.length > 0 ? renderTodos(todos) : undefined);
      const text = todos.length > 0 ? renderTodos(todos).join("\n") : "(todo list cleared)";
      return { content: [{ type: "text", text }], details: { todos } };
    },
  };
}
