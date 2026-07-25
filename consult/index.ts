import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.ts";
import { runConsult } from "./src/consult.ts";
import { buildConsultTool } from "./src/tool.ts";
import { buildConsultCommand } from "./src/command.ts";

/**
 * pi-consult — a second opinion for the agent.
 *
 * Registers a `consult` tool that shells out to `claude -p <prompt> --model <m>`
 * for read-only advice and returns it as tool output, emitting `consult:answered`.
 * `/pi-consult [model]` views or sets the default model.
 */
export default function piConsult(pi: ExtensionAPI): void {
  pi.registerTool(
    buildConsultTool({
      loadConfig: () => loadConfig(),
      runConsult: (o) => runConsult(o),
      emit: (event, data) => pi.events.emit(event, data),
    }),
  );

  const command = buildConsultCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
  });
  pi.registerCommand(command.name, command.options);
}
