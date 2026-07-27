import { test, expect } from "bun:test";
import { buildTodoTool, describeCall } from "../src/tool.ts";
import type { TodoItem } from "../../shared/index.ts";

function fakeCtx() {
  return { ui: { setWidget() {} } };
}

test("todo updates state, echoes the list, persists, and emits todo:updated", async () => {
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

test("todo emits todo:task-complete with the content of newly-done items", async () => {
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

// The row a user watching actually reads. Pure, so it needs no terminal.
test("describeCall summarises the list rather than dumping it", () => {
  expect(
    describeCall({
      todos: [
        { content: "a", status: "done" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ],
    } as never),
  ).toBe("3 items \u00b7 1 done");
  expect(describeCall({ todos: [{ content: "solo", status: "pending" }] } as never)).toBe(
    "1 item \u00b7 0 done",
  );
  // The full-list-replace model means an empty array is a real call: it clears the list.
  expect(describeCall({ todos: [] } as never)).toBe("clear");
});
