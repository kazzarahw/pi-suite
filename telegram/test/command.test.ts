import { test, expect } from "bun:test";
import { buildTelegramCommand, FIELDS } from "../src/command.ts";
import { DEFAULTS, type TelegramConfig } from "../src/config.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Thin, deliberately: `shared/test/config-command.test.ts` exercises the engine once for all
 * seven commands. What is pi-telegram's own is the field table and the readout that tells a user
 * which half of the wiring is still missing.
 */
function harness(start: Partial<TelegramConfig> = {}) {
  const notices: Array<{ msg: string; level: string }> = [];
  let cfg: TelegramConfig = { ...DEFAULTS, ...start };
  const command = buildTelegramCommand({
    loadConfig: () => cfg,
    saveConfig: (c) => {
      cfg = c;
    },
  });
  const ctx = (mode = "print") =>
    ({
      mode,
      ui: { notify: (msg: string, level: string) => notices.push({ msg, level }) },
      sessionManager: { getCwd: () => "/tmp" },
    }) as unknown as ExtensionCommandContext;
  return { command, notices, ctx, latest: () => cfg };
}

test("the token is a secret, so it is never rendered or echoed", async () => {
  const token = FIELDS.find((f) => f.key === "token")!;
  expect(token.kind === "string" && token.secret).toBe(true);

  const h = harness();
  await h.command.options.handler("token 8113038589:AAH-secret", h.ctx());
  expect(h.latest().token).toBe("8113038589:AAH-secret");
  expect(h.notices.map((n) => n.msg).join("\n")).not.toContain("8113038589");
});

test("every switch is settable from the argument form", async () => {
  const h = harness();
  await h.command.options.handler("chat 8300959766", h.ctx());
  await h.command.options.handler("bridge off", h.ctx());
  await h.command.options.handler("reply always", h.ctx());
  await h.command.options.handler("approve writes", h.ctx());
  expect(h.latest()).toMatchObject({
    chat: "8300959766",
    bridge: false,
    reply: "always",
    approve: "writes",
  });
});

test("an invalid mode is refused with the valid ones named", async () => {
  const h = harness();
  await h.command.options.handler("approve maybe", h.ctx());
  expect(h.notices[0]!.level).toBe("error");
  expect(h.notices[0]!.msg).toContain("off, writes, all");
});

/**
 * The readout names the missing half.
 *
 * Both halves are required and the reason differs — no token means nothing can connect, no chat
 * means nothing is authorised — so "it isn't working" has a different answer in each case. This is
 * the report the whole rewrite came from.
 */
test("the readout says which half of the wiring is missing", async () => {
  const noToken = harness();
  await noToken.command.options.handler("", noToken.ctx());
  expect(noToken.notices.map((n) => n.msg).join("\n")).toContain("@BotFather");

  const noChat = harness({ token: "T" });
  await noChat.command.options.handler("", noChat.ctx());
  expect(noChat.notices.map((n) => n.msg).join("\n")).toContain("no authorised chat");

  const ready = harness({ token: "T", chat: "42" });
  await ready.command.options.handler("", ready.ctx());
  expect(ready.notices).toHaveLength(1); // the field summary, and nothing else to report
});

test("there is no bare-value form to guess between three unrelated switches", async () => {
  const h = harness();
  await h.command.options.handler("always", h.ctx());
  expect(h.notices[0]!.level).toBe("error");
  expect(h.notices[0]!.msg).toContain("unknown option");
});
