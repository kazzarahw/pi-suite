import { MODES } from "../../shared/index.ts";
import {
  defineConfigCommand,
  stringField,
  enumField,
  type Field,
} from "../../shared/config-command.ts";
import type { TelegramConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => TelegramConfig;
  saveConfig: (c: TelegramConfig) => void;
}

export const FIELDS: readonly Field<TelegramConfig>[] = [
  stringField("token", "Bot token", {
    display: { placeholder: "(not set)", storedWhenPlaceholder: "" },
  }),
  enumField("mode", MODES, "Enforcement mode"),
  stringField("defaultChat", "Default chat ID", {
    display: { placeholder: "(not set)", storedWhenPlaceholder: "" },
  }),
];

/**
 * `/pi-telegram` — opens the settings panel.
 *
 * Verbs: `token`, `mode`, `defaultchat`.
 * Bare value maps to `mode` for quick toggles: `/pi-telegram notify`.
 */
export function buildTelegramCommand(deps: CommandDeps) {
  return defineConfigCommand("telegram", FIELDS, deps, {
    subtitle: "Telegram Bot API wiring",
    bareValueField: "mode",
  });
}
