import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { nonEmptyStr } from "../../shared/fields.ts";

/**
 * No `mode`.
 *
 * The enforcement dial belongs to the extensions that act on their own initiative —
 * pi-git, pi-lens, pi-memory, pi-plan all hook the session and need a say in how hard
 * they push. pi-telegram has no hooks (its wiring test asserts exactly that): it speaks
 * only when the agent calls the tool, so there is nothing for a dial to dial down. It
 * carried one anyway, copied in with the shape, wired into the settings panel as
 * "Enforcement mode" and read by nothing. pi-browser and pi-spawn are the other pure
 * tool extensions, and neither has one either.
 */
export interface TelegramConfig {
  /** Telegram Bot API token (from BotFather). */
  token: string;
  /** Default chat ID or @username for sends that omit chat_id. */
  defaultChat: string;
}

export const DEFAULTS: TelegramConfig = {
  token: "",
  defaultChat: "",
};

export const SPEC: ConfigSpec<TelegramConfig> = {
  name: "telegram",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<TelegramConfig>;
    return {
      token: nonEmptyStr(p.token, defaults.token),
      defaultChat:
        typeof p.defaultChat === "string"
          ? p.defaultChat
          : defaults.defaultChat,
    };
  },
};

/** `<agentDir>/pi-telegram.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
