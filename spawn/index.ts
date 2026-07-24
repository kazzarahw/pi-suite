import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./src/agents.ts";
import { loadConfig, saveConfig } from "./src/config.ts";
import { buildSpawnTool } from "./src/tools.ts";
import { buildSpawnCommand } from "./src/command.ts";

/**
 * pi-spawn — delegate tasks to isolated subagents.
 *
 * Registers one `spawn({ tasks })` tool that runs each delegation in a fresh
 * `pi --mode json` subprocess (streaming progress to a widget, one job or many in
 * parallel under a concurrency cap), and emits `spawn:started` / `spawn:finished`.
 * A depth guard (PI_SPAWN_DEPTH) prevents runaway nesting.
 *
 * Build spec: docs/superpowers/plans/2026-07-20-pi-spawn.md
 */
export default function piSpawn(pi: ExtensionAPI): void {
  const depth = Number(process.env.PI_SPAWN_DEPTH ?? "0") || 0;

  pi.registerTool(
    buildSpawnTool({
      discoverAgents: (cwd) => discoverAgents(cwd),
      defaultModel: () => loadConfig().defaultModel,
      concurrency: () => loadConfig().concurrency,
      emit: (event, data) => pi.events.emit(event, data),
      depth,
      childEnv: () => ({ PI_SPAWN_DEPTH: String(depth + 1) }),
    }),
  );

  const command = buildSpawnCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    listAgents: () => discoverAgents(process.cwd()),
  });
  pi.registerCommand(command.name, command.options);
}
