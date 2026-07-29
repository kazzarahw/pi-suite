import { test, expect } from "bun:test";
import { loadExtension } from "../../shared/test/harness.ts";

test("telegram registers telegram and /pi-telegram", async () => {
  const api = await loadExtension("telegram");
  expect([...api.tools.keys()]).toEqual(["telegram"]);
  expect([...api.commands.keys()]).toEqual(["pi-telegram"]);
});

test("telegram tool has an action enum with multiple verbs", async () => {
  const api = await loadExtension("telegram");
  const tool = api.tools.get("telegram")!;
  const action = (
    tool.parameters as { properties?: Record<string, { enum?: string[] }> }
  ).properties?.action;
  expect(action).toBeDefined();
  expect(action!.enum?.length ?? 0).toBeGreaterThan(1);
});

test("telegram tool has a description and promptSnippet", async () => {
  const api = await loadExtension("telegram");
  const tool = api.tools.get("telegram")!;
  expect(tool.description?.length ?? 0).toBeGreaterThan(20);
  expect(tool.promptSnippet).toBeTruthy();
});

test("telegram sends NO message on tool calls (no settle hooks)", async () => {
  const api = await loadExtension("telegram");
  // Telegram has no hooks — it's a pure tool extension.
  expect(api.subscribes("session_start")).toBe(false);
  expect(api.subscribes("agent_settled")).toBe(false);
  expect(api.subscribes("session_compact")).toBe(false);
});
