import { defineConfig, type ConfigSpec } from "../../shared/config.ts";
import { bool, nonEmptyStr, oneOf } from "../../shared/fields.ts";

/**
 * What flows back out to Telegram when the agent finishes.
 *
 * `telegram` — only turns Telegram itself started. This is the default because the two
 * situations are genuinely different: someone typing in the terminal is already looking at the
 * answer, and mirroring it to their phone is notification spam, while someone who sent a
 * message from a bus needs the reply to arrive where they sent it from.
 *
 * `always` is for the other real case — leaving a long task running and wanting to be told it
 * finished, whoever started it.
 */
export const REPLY_MODES = ["telegram", "always", "off"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

/**
 * Which tool calls have to be approved from the phone before they run.
 *
 * `writes` is `EDIT_TOOLS ∪ OPAQUE_WRITE_TOOLS` from `shared/tool-input.ts` — the tools that
 * change something — rather than a list spelled out here, for the reason that module exists:
 * pi-git and pi-lens once disagreed about which tools write, and a third opinion is how the
 * next silent gap arrives.
 *
 * `off` by default, and that is not timidity. An approval gate is a promise to answer, and an
 * unanswered gate is a stalled session — so it is opt-in, and turning it on is a statement that
 * you intend to be reachable.
 */
export const APPROVE_MODES = ["off", "writes", "all"] as const;
export type ApproveMode = (typeof APPROVE_MODES)[number];

/**
 * There is still no `mode`, and the reason is now the opposite of what it was.
 *
 * The old comment here argued pi-telegram needed no enforcement dial because it had no hooks:
 * it spoke only when the agent called its tool, so there was nothing to dial down. That was
 * true of a tool and is false of a bridge — this extension now polls on its own initiative,
 * injects user messages, and can refuse a tool call.
 *
 * What replaced the dial is three switches rather than one, because they are three unrelated
 * questions and `off / notify / block` cannot express them: whether to listen at all
 * (`bridge`), what to say back (`reply`), and what to hold for approval (`approve`). Folding
 * them into one dial would offer combinations nobody wants — "notify" has no meaning for an
 * inbound message — and `shared/mode.ts` is explicit that the shared dial is for extensions
 * whose single question is how hard to push.
 */
export interface TelegramConfig {
  /** Telegram Bot API token (from BotFather). */
  token: string;
  /**
   * The one chat allowed to drive this session, and where replies go.
   *
   * **This is an authorisation boundary, not a convenience.** A Telegram bot answers anyone
   * who finds it, and what this bridge hands an inbound message to is a coding agent with
   * file and shell access. So there is no "reply to whoever wrote in": an unset `chat` means
   * the bridge listens and *reports* who wrote, without delivering anything (see
   * `src/bridge.ts`), which is also how you learn your own chat id.
   */
  chat: string;
  /** Poll for incoming messages at all. The off switch that keeps the token in place. */
  bridge: boolean;
  reply: ReplyMode;
  approve: ApproveMode;
}

export const DEFAULTS: TelegramConfig = {
  token: "",
  chat: "",
  bridge: true,
  reply: "telegram",
  approve: "off",
};

export const SPEC: ConfigSpec<TelegramConfig> = {
  name: "telegram",
  defaults: DEFAULTS,
  parse(raw, defaults) {
    const p = raw as Partial<TelegramConfig> & { defaultChat?: unknown };
    return {
      token: nonEmptyStr(p.token, defaults.token),
      // `defaultChat` is what this key was called when the extension was a tool and the field
      // meant "the chat to use when the agent names none". The bridge's `chat` is a narrower
      // thing — the only chat it trusts — but it is the same value a user already put there,
      // and silently ignoring a populated config would look exactly like the bridge being
      // broken. Read once, on the way in; the next save writes `chat`.
      chat: nonEmptyStr(p.chat, nonEmptyStr(p.defaultChat, defaults.chat)),
      bridge: bool(p.bridge, defaults.bridge),
      reply: oneOf(p.reply, REPLY_MODES, defaults.reply),
      approve: oneOf(p.approve, APPROVE_MODES, defaults.approve),
    };
  },
};

/** Is there enough here to run? Both halves are required — see {@link TelegramConfig.chat}. */
export const canListen = (cfg: TelegramConfig): boolean => cfg.bridge && cfg.token !== "";

/** `<agentDir>/pi-telegram.json`, plus the read/write pair bound to SPEC. */
export const { configPath, loadConfig, saveConfig } = defineConfig(SPEC);
