import {
  boolField,
  defineConfigCommand,
  enumField,
  stringField,
  type Field,
} from "../../shared/config-command.ts";
import { APPROVE_MODES, REPLY_MODES, type TelegramConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => TelegramConfig;
  saveConfig: (c: TelegramConfig) => void;
}

export const FIELDS: readonly Field<TelegramConfig>[] = [
  // `secret`, and it is the reason that flag exists. The token is a credential — the whole of
  // the bot's authority — and `telegram.ts` redacts it out of every error string it builds. The
  // panel then drew it as an ordinary row, the no-TUI readout printed it, and
  // `/pi-telegram token <tok>` quoted it straight back into the terminal.
  //
  // It is also the field that proved a cycling panel cannot set everything: the only value a
  // list could offer for a token nobody has seen is the placeholder meaning *unset*, so this row
  // was unusable until `shared/settings-panel.ts` grew a text field.
  stringField("token", "Bot token", {
    secret: true,
    display: { placeholder: "(not set)", storedWhenPlaceholder: "" },
  }),
  // Not "default chat" any more. It is the *only* chat this bridge trusts, because what an
  // inbound message reaches is a coding agent with file and shell access — see
  // `TelegramConfig.chat`. Leaving it unset does not open the door; it makes the bridge report
  // who knocked, which is how you find your own id.
  stringField("chat", "Authorised chat", {
    display: { placeholder: "(not set)", storedWhenPlaceholder: "" },
  }),
  boolField("bridge", "Listen for messages"),
  enumField("reply", REPLY_MODES, "Send replies for"),
  enumField("approve", APPROVE_MODES, "Ask before running"),
];

/**
 * `/pi-telegram` — opens the settings panel.
 *
 * No bare-value form. The field it would have to guess between is now one of three unrelated
 * switches (`bridge`, `reply`, `approve`), and `bareValueField` is only sound when exactly one
 * field could plausibly be meant.
 */
export function buildTelegramCommand(deps: CommandDeps) {
  return defineConfigCommand("telegram", FIELDS, deps, {
    subtitle: "Telegram bridge — drive this session from your phone",
    readoutExtra: (cfg) =>
      cfg.token === ""
        ? "no bot token — get one from @BotFather, then /pi-telegram token <token>"
        : cfg.chat === ""
          ? "no authorised chat — message the bot and the terminal will tell you its id"
          : undefined,
  });
}
