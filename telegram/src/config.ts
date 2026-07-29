import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { nonEmptyStr, oneOf } from "../../shared/fields.ts";
import { MODES, type Mode } from "../../shared/index.ts";

export interface TelegramConfig {
  /** Telegram Bot API token (from BotFather). */
  token: string;
  /** Enforcement dial — block collapses to notify (no interdict or insist action). */
  mode: Mode;
  /** Default chat ID or @username for sends that omit chat_id. */
  defaultChat: string;
}

export const DEFAULTS: TelegramConfig = {
  token: "",
  mode: "notify",
  defaultChat: "",
};

export const SPEC: ConfigSpec<TelegramConfig> = {
  name: "telegram",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<TelegramConfig>;
    return {
      token: nonEmptyStr(p.token, defaults.token),
      mode: oneOf(p.mode, MODES, defaults.mode),
      defaultChat:
        typeof p.defaultChat === "string"
          ? p.defaultChat
          : defaults.defaultChat,
    };
  },
};

/** `<agentDir>/pi-telegram.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
