import { test, expect } from "bun:test";
import { loadExtension } from "../../shared/test/harness.ts";

test("consult registers the consult tool and /pi-consult", async () => {
  const api = await loadExtension("consult");
  expect([...api.tools.keys()]).toEqual(["consult"]);
  expect([...api.commands.keys()]).toEqual(["pi-consult"]);
});

test("consult registers no hooks — it is a pure tool extension", async () => {
  const api = await loadExtension("consult");
  expect([...api.hooks.keys()]).toEqual([]);
});

test("the consult tool declares a promptSnippet so it appears in Available tools", async () => {
  const api = await loadExtension("consult");
  expect(api.tools.get("consult")!.promptSnippet).toBeTruthy();
});
