import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.ts";
import { buildTelegramTool } from "./src/tools.ts";
import { buildTelegramCommand } from "./src/command.ts";

/**
 * pi-telegram — Send and receive Telegram messages.
 *
 * Registers a single `telegram` tool with an `action` enum:
 * send / read / list / chat.
 */
export default function piTelegram(pi: ExtensionAPI): void {
  pi.registerTool(
    buildTelegramTool({
      loadConfig: () => loadConfig(),
    }),
  );

  const command = buildTelegramCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
  });
  pi.registerCommand(command.name, command.options);
}
