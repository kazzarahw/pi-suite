import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piTelegram from "../index.ts";
import { createFakeApi, fakeCtx, within, type FakeApi } from "../../shared/test/harness.ts";
import { DEFAULTS, type TelegramConfig } from "../src/config.ts";
import type { FetchFn, TelegramMessage } from "../src/telegram.ts";

/**
 * Every test here runs against a **throwaway agent directory**.
 *
 * Not hygiene for its own sake. `loadConfig()` reads `<agentDir>/pi-telegram.json`, and on a
 * machine that actually uses this extension that file holds a live bot token — so a wiring test
 * that fires `session_start` against the real config would start polling api.telegram.org from
 * `bun test`, with the developer's own bot. The injected `fetch` closes the other half of the
 * same hole.
 */
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-telegram-wiring-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
afterAll(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
});

const writeConfig = (cfg: Partial<TelegramConfig>): void => {
  writeFileSync(join(AGENT_DIR, "pi-telegram.json"), JSON.stringify({ ...DEFAULTS, ...cfg }));
};

beforeEach(() => {
  writeConfig({});
});

const message = (text: string): TelegramMessage => ({
  message_id: 1,
  chat: { id: 42, type: "private" },
  date: 1,
  text,
});

/** A Bot API that hands over `pages` one poll at a time and records what was sent. */
function fakeApi(pages: TelegramMessage[][] = []) {
  const sent: string[] = [];
  let cursor = 0;
  let id = 100;
  const fetch: FetchFn = (url) => {
    const u = new URL(url);
    const ok = (result: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
    if (u.pathname.endsWith("/sendMessage")) {
      sent.push(u.searchParams.get("text") ?? "");
      return ok({ message_id: 1 });
    }
    if (u.searchParams.get("offset") === "-1") return ok([]);
    const page = cursor < pages.length ? pages[cursor++]! : [];
    return ok(page.map((m) => ({ update_id: id++, message: m })));
  };
  return { fetch, sent };
}

function load(pages: TelegramMessage[][] = []): { api: FakeApi; telegram: ReturnType<typeof fakeApi> } {
  const api = createFakeApi();
  const telegram = fakeApi(pages);
  piTelegram(api as unknown as Parameters<typeof piTelegram>[0], telegram.fetch);
  return { api, telegram };
}

async function waitFor(check: () => boolean, label: string, ms = 2000): Promise<void> {
  await within(
    ms,
    (async () => {
      while (!check()) await new Promise((r) => setTimeout(r, 1));
    })(),
  ).catch(() => {
    throw new Error(`timed out waiting for: ${label}`);
  });
}

// ---------------------------------------------------------------------------
// The shape of the extension.
// ---------------------------------------------------------------------------

/**
 * No tool, and that is the fix.
 *
 * The previous version registered `telegram` with `send`/`read`/`list`/`chat` so the *agent* could
 * message Telegram. A messaging extension exists to carry messages **in**; everything it does is
 * automatic, and `shared/surface.ts` already states the rule — automatic behavior is a hook, not a
 * tool, which is why pi-git registers none either.
 */
test("telegram registers no tool, and only /pi-telegram", () => {
  const { api } = load();
  expect([...api.tools.keys()]).toEqual([]);
  expect([...api.commands.keys()]).toEqual(["pi-telegram"]);
});

/**
 * The hooks it now has, named exactly.
 *
 * This test used to assert the opposite — `subscribes("session_start") === false`, under the
 * heading "telegram sends NO message on tool calls (no settle hooks)" — which pinned the defect in
 * place as though it were a safety property. Nothing polled, so nothing could ever arrive.
 */
test("telegram subscribes exactly the hooks a bridge needs", () => {
  const { api } = load();
  expect([...api.hooks.keys()].sort()).toEqual([
    "agent_settled",
    "message_end",
    "session_shutdown",
    "session_start",
    "tool_call",
  ]);
});

// ---------------------------------------------------------------------------
// Inbound: the message becomes a turn.
// ---------------------------------------------------------------------------

/**
 * The whole point of the rewrite, asserted at the wiring layer.
 *
 * `pi.sendUserMessage` is the API the tool version never called, and without this line a token
 * could be configured, a message sent, and absolutely nothing would happen — which is exactly
 * what was reported.
 */
test("a message from the authorised chat becomes a user message", async () => {
  writeConfig({ token: "T", chat: "42" });
  const { api, telegram } = load([[message("run the tests")]]);
  await api.fire("session_start", {}, fakeCtx());
  await waitFor(() => api.userMessages.length > 0, "a user message");
  await api.fire("session_shutdown");

  expect(api.userMessages).toHaveLength(1);
  expect(api.userMessages[0]!.content).toBe("run the tests");
  // `followUp` rather than `steer`: a second message arriving mid-task queues behind the work
  // instead of cutting into it.
  expect(api.userMessages[0]!.options).toEqual({ deliverAs: "followUp" });
  expect(telegram.sent).toEqual([]);
});

/**
 * A one-shot `pi -p` run has no user to bridge to and no turn after this one to deliver into.
 *
 * Left listening, it would also hold the process open waiting for a message nobody is going to
 * send — the same failure mode `plan/index.ts` guards its queued message against.
 */
test("with no UI the bridge never starts", async () => {
  writeConfig({ token: "T", chat: "42" });
  const { api, telegram } = load([[message("hello")]]);
  await api.fire("session_start", {}, fakeCtx({ hasUI: false }));
  await new Promise((r) => setTimeout(r, 20));
  expect(api.userMessages).toEqual([]);
  expect(telegram.sent).toEqual([]);
});

test("with no token configured, session_start starts nothing", async () => {
  const { api, telegram } = load([[message("hello")]]);
  await api.fire("session_start", {}, fakeCtx());
  await new Promise((r) => setTimeout(r, 20));
  expect(api.userMessages).toEqual([]);
  expect(telegram.sent).toEqual([]);
});

/**
 * Configuring the bridge starts it, without a restart.
 *
 * This is the exact path a first-time user takes: install, `/pi-telegram token …`, message the bot.
 * If the loop only ever started at `session_start`, that sequence would go on doing nothing until
 * Pi was relaunched — which is indistinguishable from the extension being broken, and is what was
 * reported.
 */
test("setting the token from the command starts listening straight away", async () => {
  const { api, telegram } = load([[message("now listening")]]);
  await api.fire("session_start", {}, fakeCtx());
  // Nothing to listen with yet, so nothing has happened.
  await new Promise((r) => setTimeout(r, 20));
  expect(api.userMessages).toEqual([]);

  const command = api.commands.get("pi-telegram")!;
  writeConfig({ chat: "42" });
  await command.handler("token T", { mode: "print", ui: { notify: () => {} } });

  await waitFor(() => api.userMessages.length > 0, "a user message after configuring");
  await api.fire("session_shutdown");
  expect(api.userMessages[0]!.content).toBe("now listening");
  expect(telegram.sent).toEqual([]);
});

// ---------------------------------------------------------------------------
// Outbound: the reply goes back where the question came from.
// ---------------------------------------------------------------------------

test("the final assistant text is relayed for a turn Telegram started", async () => {
  writeConfig({ token: "T", chat: "42" });
  const { api, telegram } = load([[message("run the tests")]]);
  await api.fire("session_start", {}, fakeCtx());
  await waitFor(() => api.userMessages.length > 0, "a user message");

  // Mid-turn commentary, then the answer. Only the last one survives to settle.
  await api.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "looking" }] } });
  await api.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "941 pass" }] } });
  await api.fire("agent_settled");
  await api.fire("session_shutdown");
  expect(telegram.sent).toEqual(["941 pass"]);
});

/**
 * A local turn is not mirrored, at the default setting.
 *
 * Someone at the keyboard is already reading the answer, and pushing every local reply to their
 * phone trains them to ignore the notification that matters.
 */
test("a turn nobody asked for over Telegram is not relayed", async () => {
  writeConfig({ token: "T", chat: "42" });
  const { api, telegram } = load();
  await api.fire("session_start", {}, fakeCtx());
  await api.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  await api.fire("agent_settled");
  await api.fire("session_shutdown");
  expect(telegram.sent).toEqual([]);
});

test("reply always relays a local turn too", async () => {
  writeConfig({ token: "T", chat: "42", reply: "always" });
  const { api, telegram } = load();
  await api.fire("session_start", {}, fakeCtx());
  await api.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  await api.fire("agent_settled");
  await api.fire("session_shutdown");
  expect(telegram.sent).toEqual(["done"]);
});

test("settling with no assistant prose sends nothing", async () => {
  writeConfig({ token: "T", chat: "42", reply: "always" });
  const { api, telegram } = load();
  await api.fire("session_start", {}, fakeCtx());
  await api.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall" }] } });
  await api.fire("agent_settled");
  expect(telegram.sent).toEqual([]);
});

/** The relayed text is consumed, so a later settle cannot repeat last turn's answer. */
test("a relayed reply is not sent twice", async () => {
  writeConfig({ token: "T", chat: "42", reply: "always" });
  const { api, telegram } = load();
  await api.fire("session_start", {}, fakeCtx());
  await api.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  await api.fire("agent_settled");
  await api.fire("agent_settled");
  expect(telegram.sent).toEqual(["done"]);
});

// ---------------------------------------------------------------------------
// The approval gate.
// ---------------------------------------------------------------------------

test("with approve off, no tool call is held up", async () => {
  writeConfig({ token: "T", chat: "42" });
  const { api, telegram } = load();
  await api.fire("session_start", {}, fakeCtx());
  const result = await api.fire("tool_call", { toolName: "bash", input: { command: "rm -rf /" } });
  await api.fire("session_shutdown");
  expect(result).toBeUndefined();
  expect(telegram.sent).toEqual([]);
});

test("a gated call is sent for approval and refused when the answer is no", async () => {
  writeConfig({ token: "T", chat: "42", approve: "writes" });
  const { api, telegram } = load([[], [message("no")]]);
  await api.fire("session_start", {}, fakeCtx());
  const result = (await api.fire("tool_call", {
    toolName: "write",
    input: { path: "README.md" },
  })) as { block?: boolean; reason?: string } | undefined;
  await api.fire("session_shutdown");

  expect(telegram.sent[0]).toContain("README.md");
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("did NOT run");
});

test("a gated call approved from Telegram goes ahead", async () => {
  writeConfig({ token: "T", chat: "42", approve: "writes" });
  const { api } = load([[], [message("yes")]]);
  await api.fire("session_start", {}, fakeCtx());
  const result = await api.fire("tool_call", { toolName: "edit", input: { file_path: "a.ts" } });
  await api.fire("session_shutdown");
  expect(result).toBeUndefined();
});

/**
 * The fail-open half, and the reason it is not a contradiction.
 *
 * Silence from a reachable owner refuses; a question that could not be *sent* does not, because
 * otherwise a flat phone battery stops the person at the keyboard from working. This gate is a
 * convenience for operating remotely — Pi's own permission system is still in front of every one
 * of these calls — the same distinction `plan/README.md` draws about its edit gate.
 */
test("a call is allowed through when the approval could not be sent at all", async () => {
  writeConfig({ token: "T", chat: "", approve: "all" });
  const { api } = load();
  await api.fire("session_start", {}, fakeCtx());
  expect(await api.fire("tool_call", { toolName: "write", input: { path: "a.ts" } })).toBeUndefined();
});

test("with the bridge not listening, the gate never waits", async () => {
  writeConfig({ token: "", approve: "all" });
  const { api } = load();
  await api.fire("session_start", {}, fakeCtx());
  expect(await api.fire("tool_call", { toolName: "bash", input: { command: "ls" } })).toBeUndefined();
});

/**
 * A malformed event passes through instead of breaking the turn.
 *
 * Per `shared/README.md`: a hook must never break the turn it observes, and a gate that crashes
 * the call it meant to question is worse than no gate. At `writes` an event with no `toolName`
 * matches nothing and is waved through before anything can go wrong with it — the failure this
 * guards against is the gate itself throwing, not the tool being unrecognised.
 */
test("a malformed tool_call event is not gated, and does not throw", async () => {
  writeConfig({ token: "T", chat: "42", approve: "writes" });
  const { api, telegram } = load();
  await api.fire("session_start", {}, fakeCtx());
  const result = await api.fire("tool_call", { input: null }, fakeCtx());
  await api.fire("session_shutdown");
  expect(result).toBeUndefined();
  expect(telegram.sent).toEqual([]);
});
