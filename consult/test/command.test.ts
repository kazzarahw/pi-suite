import { test, expect } from "bun:test";
import { buildConsultCommand } from "../src/command.ts";
import type { ConsultConfig } from "../src/config.ts";

function fakeCtx() {
  return { ui: { notify() {} } };
}

test("/pi-consult <model> saves it as the new default", async () => {
  const saved: ConsultConfig[] = [];
  const command = buildConsultCommand({
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus", "sonnet"] }),
    saveConfig: (c) => saved.push(c),
  });
  await command.options.handler("sonnet", fakeCtx() as any);
  expect(saved).toEqual([{ defaultModel: "sonnet", allowedModels: ["opus", "sonnet"] }]);
});

test("/pi-consult with no argument does not save", async () => {
  const saved: ConsultConfig[] = [];
  const command = buildConsultCommand({
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus"] }),
    saveConfig: (c) => saved.push(c),
  });
  await command.options.handler("  ", fakeCtx() as any);
  expect(saved).toEqual([]);
});

test("getArgumentCompletions filters allowedModels by prefix", () => {
  const command = buildConsultCommand({
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus", "sonnet", "haiku"] }),
    saveConfig: () => {},
  });
  expect(command.options.getArgumentCompletions("s")).toEqual([{ value: "sonnet", label: "sonnet" }]);
  expect(command.options.getArgumentCompletions("z")).toBeNull();
});
