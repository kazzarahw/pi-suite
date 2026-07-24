import { test, expect } from "bun:test";
import { loadExtension, fakeCtx } from "../../shared/test/harness.ts";

test("todo registers todo_write and /pi-todo", async () => {
  const api = await loadExtension("todo");
  expect([...api.tools.keys()]).toEqual(["todo_write"]);
  expect([...api.commands.keys()]).toEqual(["pi-todo"]);
});

test("todo subscribes the session and settle hooks", async () => {
  const api = await loadExtension("todo");
  for (const hook of ["session_start", "session_compact", "agent_settled"]) {
    expect(api.subscribes(hook)).toBe(true);
  }
});

// THE print-mode hang guard. Injecting a message when there is no interactive UI
// makes pi wait forever for a "next prompt" that never arrives — this cost a
// 72-minute zombie process once. Pinned here so it cannot regress silently.
test("todo sends NO message on settle when there is no UI (print/JSON mode)", async () => {
  const api = await loadExtension("todo");
  const tool = api.tools.get("todo_write")!;
  await tool.execute("1", { todos: [{ content: "unfinished", status: "pending" }] } as never, undefined, undefined, fakeCtx());
  api.messages.length = 0;

  await api.fire("agent_settled", {}, fakeCtx({ hasUI: false }));
  expect(api.messages).toEqual([]);
});

test("todo DOES nudge on settle with a UI and a pending todo", async () => {
  const api = await loadExtension("todo");
  const tool = api.tools.get("todo_write")!;
  await tool.execute("1", { todos: [{ content: "unfinished", status: "pending" }] } as never, undefined, undefined, fakeCtx());
  api.messages.length = 0;

  await api.fire("agent_settled", {}, fakeCtx({ hasUI: true }));
  expect(api.messages.length).toBe(1);
  expect(JSON.stringify(api.messages[0])).toContain("unfinished");
});

test("todo does not nudge when nothing is pending", async () => {
  const api = await loadExtension("todo");
  const tool = api.tools.get("todo_write")!;
  await tool.execute("1", { todos: [{ content: "finished", status: "done" }] } as never, undefined, undefined, fakeCtx());
  api.messages.length = 0;

  await api.fire("agent_settled", {}, fakeCtx({ hasUI: true }));
  expect(api.messages).toEqual([]);
});

test("todo does not inject on session_start without a UI", async () => {
  const api = await loadExtension("todo");
  await api.fire("session_start", {}, fakeCtx({ hasUI: false }));
  expect(api.messages).toEqual([]);
});

test("todo_write emits todo:updated and todo:task-complete", async () => {
  const api = await loadExtension("todo");
  const tool = api.tools.get("todo_write")!;
  const ctx = fakeCtx();
  await tool.execute("1", { todos: [{ content: "a", status: "in_progress" }] } as never, undefined, undefined, ctx);
  await tool.execute("2", { todos: [{ content: "a", status: "done" }] } as never, undefined, undefined, ctx);

  const names = api.emitted.map((e) => e.event);
  expect(names).toContain("todo:updated");
  expect(names).toContain("todo:task-complete");
});

test("todo_write paints the widget", async () => {
  const api = await loadExtension("todo");
  const ctx = fakeCtx();
  await api.tools
    .get("todo_write")!
    .execute("1", { todos: [{ content: "a", status: "pending" }] } as never, undefined, undefined, ctx);
  expect(ctx.uiCalls.widgets.some((w) => w.id === "todo")).toBe(true);
});
