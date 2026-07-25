import { test, expect } from "bun:test";
import { loadExtension } from "../../shared/test/harness.ts";

test("browser registers the browser tool and /pi-browser", async () => {
  const api = await loadExtension("browser");
  expect([...api.tools.keys()]).toEqual(["browser"]);
  expect([...api.commands.keys()]).toEqual(["pi-browser"]);
});

test("browser registers no hooks — it is a pure tool extension", async () => {
  const api = await loadExtension("browser");
  expect([...api.hooks.keys()]).toEqual([]);
});

// House rule: many variant actions collapse behind ONE action-enum tool rather
// than one tool per verb. Pinned so the surface cannot quietly fan back out.
test("browser exposes its verbs through a single action enum, not many tools", async () => {
  const api = await loadExtension("browser");
  expect(api.tools.size).toBe(1);
  const params = api.tools.get("browser")!.parameters as { properties?: Record<string, unknown> };
  expect(params.properties).toHaveProperty("action");
});
