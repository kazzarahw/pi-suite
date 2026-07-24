import { test, expect } from "bun:test";
import { buildTodoTool } from "../src/tool.ts";
import type { TodoItem } from "pi-shared";

function fakeCtx() {
  return { ui: { setWidget() {} } };
}

test("todo_write updates state, echoes the list, persists, and emits todo:updated", async () => {
  let state: TodoItem[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const persisted: TodoItem[][] = [];
  const tool = buildTodoTool({
    getState: () => state,
    setState: (t) => {
      state = t;
    },
    emit: (event, data) => events.push({ event, data }),
    persist: (t) => persisted.push(t),
  });

  const res = await tool.execute(
    "id",
    { todos: [{ content: "a", status: "in_progress" }] },
    undefined,
    undefined,
    fakeCtx() as any,
  );

  expect(res.details.todos.map((t) => t.content)).toEqual(["a"]);
  expect(res.content[0]).toEqual({ type: "text", text: expect.stringContaining("a") });
  expect(events.some((e) => e.event === "todo:updated")).toBe(true);
  expect(persisted).toHaveLength(1);
});

test("todo_write emits todo:task-complete with the content of newly-done items", async () => {
  let state: TodoItem[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const tool = buildTodoTool({
    getState: () => state,
    setState: (t) => {
      state = t;
    },
    emit: (event, data) => events.push({ event, data }),
    persist: () => {},
  });

  await tool.execute("id1", { todos: [{ content: "a", status: "in_progress" }] }, undefined, undefined, fakeCtx() as any);
  const idA = state[0]!.id;
  await tool.execute("id2", { todos: [{ id: idA, content: "a", status: "done" }] }, undefined, undefined, fakeCtx() as any);

  const completions = events.filter((e) => e.event === "todo:task-complete");
  expect(completions).toEqual([{ event: "todo:task-complete", data: { task: "a" } }]);
});
