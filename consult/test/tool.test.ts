import { test, expect } from "bun:test";
import { buildConsultTool } from "../src/tool.ts";

// Minimal fake ExtensionContext — only the ui.setStatus surface the tool touches.
function fakeCtx() {
  return { ui: { setStatus() {} } };
}

test("consult tool returns advice as text and emits consult:answered", async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const tool = buildConsultTool({
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus"] }),
    runConsult: async ({ model, prompt }) => `advice for ${prompt} from ${model}`,
    emit: (event, data) => events.push({ event, data }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await tool.execute("id1", { prompt: "help" }, undefined, undefined, fakeCtx() as any);
  expect(res.content[0]).toEqual({ type: "text", text: "advice for help from opus" });
  expect(res.details).toEqual({ model: "opus" });
  expect(events).toEqual([{ event: "consult:answered", data: { model: "opus", topic: "help" } }]);
});

test("consult tool prefers params.model over the configured default", async () => {
  const tool = buildConsultTool({
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus", "sonnet"] }),
    runConsult: async ({ model }) => `from ${model}`,
    emit: () => {},
  });
  const res = await tool.execute("id2", { prompt: "q", model: "sonnet" }, undefined, undefined, fakeCtx() as any);
  expect(res.content[0]).toEqual({ type: "text", text: "from sonnet" });
  expect(res.details).toEqual({ model: "sonnet" });
});
