import { test, expect } from "bun:test";
import { buildConsultCommand, subtitleFor } from "../src/command.ts";
import type { ConsultConfig } from "../src/config.ts";

function fakeCtx() {
  return { ui: { notify() {} } };
}

test("/pi-consult <model> saves it as the new default", async () => {
  const saved: ConsultConfig[] = [];
  const command = buildConsultCommand({ which: () => true,
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus", "sonnet"] }),
    saveConfig: (c) => saved.push(c),
  });
  await command.options.handler("sonnet", fakeCtx() as any);
  expect(saved).toEqual([{ defaultModel: "sonnet", allowedModels: ["opus", "sonnet"] }]);
});

test("/pi-consult with no argument does not save", async () => {
  const saved: ConsultConfig[] = [];
  const command = buildConsultCommand({ which: () => true,
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus"] }),
    saveConfig: (c) => saved.push(c),
  });
  await command.options.handler("  ", fakeCtx() as any);
  expect(saved).toEqual([]);
});

test("getArgumentCompletions filters allowedModels by prefix", () => {
  const command = buildConsultCommand({ which: () => true,
    loadConfig: () => ({ defaultModel: "opus", allowedModels: ["opus", "sonnet", "haiku"] }),
    saveConfig: () => {},
  });
  expect(command.options.getArgumentCompletions("s")).toEqual([{ value: "sonnet", label: "sonnet" }]);
  expect(command.options.getArgumentCompletions("z")).toBeNull();
});

// --- The panel's subtitle --------------------------------------------------
//
// pi-lens shows a live health line and pi-spawn its agent roster; pi-consult showed a
// fixed sentence. A config holding `defaultModel: "some-new-model"` therefore rendered as
// though nothing were wrong — and the panel will store any string, since any string is a
// legal model name — while every `consult` call failed until someone thought to look.

const cfg = (over: Partial<ConsultConfig> = {}): ConsultConfig => ({
  defaultModel: "opus",
  allowedModels: ["opus", "sonnet", "haiku"],
  ...over,
});

test("the subtitle leads with a missing CLI, which breaks the tool outright", () => {
  expect(subtitleFor(cfg(), () => false)).toContain("not on PATH");
});

test("the subtitle flags a default that is not one of the known models", () => {
  const line = subtitleFor(cfg({ defaultModel: "some-new-model" }), () => true);
  expect(line).toContain("some-new-model");
  expect(line).toContain("opus, sonnet, haiku");
});

test("a recognised default gets the ordinary description", () => {
  expect(subtitleFor(cfg(), () => true)).toBe("second-opinion model for the consult tool");
});

test("an emptied model list makes no claim about what is recognised", () => {
  // allowedModels is a preset list, not an allowlist. Emptying it means "I have no
  // presets", not "nothing is valid".
  expect(subtitleFor(cfg({ defaultModel: "anything", allowedModels: [] }), () => true)).toBe(
    "second-opinion model for the consult tool",
  );
});
