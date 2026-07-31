import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.ts";
import { buildTelegramCommand } from "./src/command.ts";
import { createBridge, type Bridge } from "./src/bridge.ts";
import { defaultFetch, type FetchFn } from "./src/telegram.ts";
import { approvalQuestion, needsApproval, readVerdict, refusalReason } from "./src/approve.ts";
import { assistantText, shouldRelay } from "./src/relay.ts";

/**
 * How long an approval waits before it counts as unanswered.
 *
 * Long, because the person is expected to be away from the keyboard — that is the entire
 * premise — and short enough that a forgotten question does not hold a tool call open forever.
 */
const APPROVAL_MS = 5 * 60_000;

/**
 * pi-telegram — drive this session from Telegram, and hear back from it.
 *
 * **Registers no tool, deliberately.** The previous version was one: `send`, `read`, `list`, and
 * a `chat` round-trip, so the *agent* could message Telegram. That is the wrong direction. The
 * thing a Telegram extension is for is carrying a person into a session they are not sitting in
 * front of, and the old one could not: it polled only when called, so a message sent to the bot
 * reached nothing and the session never knew. `pi.sendUserMessage` is the API that makes it work
 * and the tool version never called it.
 *
 * So this is hooks only, in the shape `shared/surface.ts` already names — "automatic behavior is
 * a hook, not a tool", which is why pi-git registers none either:
 *
 * - `session_start` / `session_shutdown` — run the long-poll loop for the life of the session.
 * - `message_end` / `agent_settled` — capture the final assistant text and relay it.
 * - `tool_call` — hold a call for approval, when `approve` says so.
 *
 * `fetch` is a parameter for the reason `src/telegram.ts` gives about its own `FetchFn`, and it
 * matters more here than there: this is the layer that decides to *start polling*, so a test that
 * drives `session_start` against the real `fetch` would open a live connection to
 * api.telegram.org with whatever token the developer has configured. Pi calls this with one
 * argument; the second exists so the wiring can be exercised without a network.
 */
export default function piTelegram(pi: ExtensionAPI, fetch: FetchFn = defaultFetch): void {
  /**
   * The last assistant prose seen this run, and whether Telegram asked for it.
   *
   * Both exist because `agent_settled` carries no payload — it is `{ type: "agent_settled" }` —
   * so the text has to be caught from `message_end` on the way past and held. See
   * `src/relay.ts`, where the reading of a message is kept pure.
   */
  let lastText: string | null = null;
  let startedByTelegram = false;

  let bridge: Bridge | null = null;
  /** Set once a context exists, so the bridge can talk to the terminal it was started from. */
  let notify: (message: string, level: "info" | "warning" | "error") => void = () => {};

  const ensureBridge = (): Bridge => {
    bridge ??= createBridge({
      loadConfig: () => loadConfig(),
      fetch,
      deliver: (text) => {
        // The inbound half, and the whole point of the extension. `sendUserMessage` always
        // triggers a turn; `followUp` queues it rather than cutting into a turn already running,
        // which is what a second message arriving mid-task should do.
        startedByTelegram = true;
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      },
      notify: (message, level) => notify(`[pi-telegram] ${message}`, level),
    });
    return bridge;
  };

  const command = buildTelegramCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => {
      saveConfig(c);
      // Config changes have to reach the loop without a restart: turning the bridge on, or
      // pasting a token, should start listening now. Stop-then-start rather than a signal,
      // because `start` re-reads config and is a no-op when there is nothing to listen with.
      const b = ensureBridge();
      b.stop();
      b.start();
    },
  });
  pi.registerCommand(command.name, command.options);

  pi.on("session_start", async (_event, ctx) => {
    notify = (message, level) => ctx?.ui?.notify?.(message, level);
    // One-shot print/JSON runs have no user to bridge to and no turn after this one to deliver
    // into, so listening would hold the process open waiting for a message nobody will send.
    if (!ctx.hasUI) return;
    ensureBridge().start();
  });

  pi.on("session_shutdown", async () => {
    bridge?.stop();
  });

  // Captured on the way past, relayed at settle. Every assistant message overwrites the last,
  // so what survives to settle is the final one — which is the answer, rather than the running
  // commentary between tool calls.
  pi.on("message_end", async (event) => {
    const text = assistantText((event as { message?: unknown }).message);
    if (text) lastText = text;
  });

  pi.on("agent_settled", async () => {
    const text = lastText;
    lastText = null;
    const fromTelegram = startedByTelegram;
    startedByTelegram = false;
    if (!text || !bridge) return;
    if (!shouldRelay(loadConfig().reply, fromTelegram)) return;
    await bridge.say(text);
  });

  /**
   * Hold a tool call until Telegram approves it.
   *
   * Two things this must never do, and they pull in opposite directions:
   *
   * - **Never let silence be consent.** No answer, or an answer that is not a clear yes, refuses.
   * - **Never wedge a session over a network problem.** If the question cannot be *sent* — no
   *   token, no authorised chat, bridge off, Telegram unreachable — the call is allowed through.
   *   The alternative is that a flat phone battery stops the person at the keyboard from working,
   *   and this gate is a convenience for operating remotely, not a security boundary: Pi's own
   *   permission system is still in front of every one of these calls. Same distinction
   *   `plan/README.md` draws about its edit gate being a discipline aid rather than enforcement.
   *
   * The line between them is *who did not answer*: an unreachable chat fails open, a reachable
   * one that said nothing fails closed.
   */
  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    try {
      const cfg = loadConfig();
      if (!needsApproval(cfg.approve, event.toolName)) return undefined;
      if (!bridge?.listening()) return undefined;

      // `ctx.signal` is the turn's, live while the agent streams: pressing Esc releases the wait
      // instead of holding a tool call the user has already given up on.
      const answer = await bridge.ask(
        approvalQuestion(event.toolName, event.input),
        APPROVAL_MS,
        ctx?.signal,
      );
      // The fail-open half: the question never reached anyone, so there is nobody whose silence
      // could mean no. `Answer` keeps this distinct from a silence on purpose.
      if (!answer.asked) return undefined;

      const verdict = readVerdict(answer.text);
      if (verdict === "approved") return undefined;
      return { block: true, reason: refusalReason(event.toolName, verdict, answer.text) };
    } catch (err) {
      // Per `shared/README.md`: a hook must never break the turn it observes. A gate that
      // crashes the call it meant to question is worse than no gate.
      const message = err instanceof Error ? err.message : String(err);
      if (ctx?.hasUI) ctx.ui?.notify?.(`[pi-telegram] approval failed: ${message}`, "error");
      else console.error(`[pi-telegram] approval failed: ${message}`);
      return undefined;
    }
  });
}
