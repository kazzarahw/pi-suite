import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.ts";
import { defaultExec } from "./src/browser.ts";
import { buildBrowserTool } from "./src/tools.ts";
import { buildBrowserCommand } from "./src/command.ts";

/**
 * pi-browser — the web, in one house-style tool.
 *
 * Registers a single `browser` tool: an `action` enum wrapping the agent-browser
 * CLI (open / snapshot / read / search / click / type / … over a persistent
 * session). `search` and `read` fold in what would have been web_search / web_fetch.
 *
 * Build spec: docs/superpowers/plans/2026-07-20-pi-browser.md
 */
export default function piBrowser(pi: ExtensionAPI): void {
  pi.registerTool(
    buildBrowserTool({
      loadConfig: () => loadConfig(),
      exec: defaultExec,
    }),
  );

  const command = buildBrowserCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
  });
  pi.registerCommand(command.name, command.options);
}
