import {
  defineConfigCommand,
  stringField,
  type Field,
} from "../../shared/config-command.ts";
import type { TelegramConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => TelegramConfig;
  saveConfig: (c: TelegramConfig) => void;
}

export const FIELDS: readonly Field<TelegramConfig>[] = [
  // `secret`, and it is the reason that flag exists. The token is a credential — the whole
  // of the bot's authority — and `telegram.ts` redacts it out of every error string it
  // builds. The panel then drew it as an ordinary row, the no-TUI readout printed it, and
  // `/pi-telegram token <tok>` quoted it straight back into the terminal.
  stringField("token", "Bot token", {
    secret: true,
    display: { placeholder: "(not set)", storedWhenPlaceholder: "" },
  }),
  stringField("defaultChat", "Default chat ID", {
    display: { placeholder: "(not set)", storedWhenPlaceholder: "" },
  }),
];

/**
 * `/pi-telegram` — opens the settings panel.
 *
 * Verbs: `token`, `defaultchat`. No bare-value form: the field it used to map to was
 * `mode`, which this extension does not have (see `config.ts`), and neither remaining
 * field has a value a user would type without naming it — pi-browser omits it for the
 * same reason.
 */
export function buildTelegramCommand(deps: CommandDeps) {
  return defineConfigCommand("telegram", FIELDS, deps, {
    subtitle: "Telegram Bot API wiring",
  });
}
