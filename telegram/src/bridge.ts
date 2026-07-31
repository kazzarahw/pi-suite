/**
 * The bridge: one long-poll loop, and the single place inbound messages are routed.
 *
 * pi-telegram used to be a tool the agent could call to send a message. That is backwards, and
 * the extension's own README said so without noticing — *"Automatic behavior: None. It
 * registers no hooks and subscribes to nothing"* was written as a safety property of a
 * messaging extension whose entire purpose is to carry messages **in**. Nothing polled, so
 * nothing could arrive: a bot token could be configured, a message sent, and the session would
 * never hear about it.
 *
 * What the bridge does instead is carry the user into the session. `pi.sendUserMessage` is the
 * API that makes it possible and the old implementation never called it.
 *
 * **One reader.** Every inbound message arrives through this loop and nowhere else, which is
 * what lets the approval gate work at all: a second consumer of `getUpdates` would race this
 * one for the reply, and whichever won would confirm the offset and make the message vanish
 * for the other. So {@link Bridge.ask} does not read — it parks a continuation that this loop
 * hands the next owner message to, in place of delivering it to the agent.
 */
import { deadline } from "../../shared/deadline.ts";
import { canListen, type TelegramConfig } from "./config.ts";
import {
  describeSender,
  matchesChat,
  messageOf,
  poll,
  POLL_TIMEOUT_SEC,
  sendMessage,
  startingOffset,
  wasAborted,
  type FetchFn,
  type TelegramDeps,
  type TelegramUpdate,
} from "./telegram.ts";

/** Telegram's own ceiling for one text message. */
export const MAX_MESSAGE_CHARS = 4096;

/** Bound for a single outbound send, in the spirit of `DEFAULT_EXEC_TIMEOUT_MS`. */
const SEND_TIMEOUT_MS = 15_000;

/** Backoff after a failed poll: 2s, 4s, 8s … capped, so a dead network is not a busy loop. */
const BACKOFF_CAP_MS = 60_000;
export const backoffFor = (failures: number): number =>
  Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.min(failures, 6));

/**
 * How many consecutive poll failures before the user is told.
 *
 * Not the first, deliberately: a laptop that slept, a train tunnel, a Telegram blip — the loop
 * recovers from all of them on its own, and an error notice per transient failure is the noise
 * `drainSkips` and `warnOnce` exist to prevent elsewhere in the suite. Three in a row with
 * backoff between them is around fourteen seconds of genuinely not working.
 */
const WARN_AFTER_FAILURES = 3;

/**
 * The smallest gap between polls, and why there has to be one.
 *
 * A long poll normally holds the connection for {@link POLL_TIMEOUT_SEC}, so the loop spends its
 * life waiting and this never applies. The case it exists for is the one where that stops being
 * true: a proxy, a stub, or a Telegram fault that answers `getUpdates` *immediately* and
 * successfully turns this into a loop of resolved promises with no macrotask in it — which does
 * not merely spin a core, it starves the timer queue, so nothing else in the process runs again.
 * A quarter second costs nothing against a 25-second poll and makes that unreachable.
 */
const MIN_POLL_GAP_MS = 250;

/** Cut to Telegram's limit, saying so, rather than having the API reject the whole message. */
export function fitMessage(text: string, max: number = MAX_MESSAGE_CHARS): string {
  if (text.length <= max) return text;
  const marker = "\n[… truncated]";
  return `${text.slice(0, max - marker.length)}${marker}`;
}

export interface BridgeDeps {
  loadConfig: () => TelegramConfig;
  fetch: FetchFn;
  /** Hand an owner message to the agent, as a message from the user. */
  deliver: (text: string) => void;
  /** Say something about the bridge itself, in the *terminal* — never to Telegram. */
  notify: (message: string, level: "info" | "warning" | "error") => void;
  /** Overridable only so tests do not sit through a real long poll. */
  pollTimeoutSec?: number;
  /** Overridable only so tests do not sit through a real backoff. */
  backoffMs?: (failures: number) => number;
  /** Overridable only so tests do not sit through {@link MIN_POLL_GAP_MS} once per poll. */
  gapMs?: number;
}

/**
 * The outcome of asking the owner something.
 *
 * `asked` and `text` are separate because a caller has to tell "nobody heard the question" from
 * "they heard it and said nothing", and one nullable string cannot. The approval gate turns on
 * exactly that distinction: an unreachable chat has to fail *open*, since otherwise a flat phone
 * battery stops the person at the keyboard from working, while a reachable chat that stayed
 * silent has to fail *closed*, because silence is not consent.
 */
export type Answer = { asked: false } | { asked: true; text: string | null };

export interface Bridge {
  /** Begin polling, if there is a token and the bridge is on. Idempotent. */
  start(): void;
  /** Stop polling and release anything waiting on an answer. Idempotent. */
  stop(): void;
  /** Send to the owner chat. `false` when there is nowhere to send, or the send failed. */
  say(text: string): Promise<boolean>;
  /**
   * Ask the owner something and wait for their next message.
   *
   * `signal` is the turn's — `ExtensionContext.signal`, which is live while the agent is
   * streaming. Without it a user who pressed Esc would still be held for the full timeout by a
   * tool call they had already abandoned.
   */
  ask(question: string, timeoutMs: number, signal?: AbortSignal): Promise<Answer>;
  /** Is the loop running? An approval gate must not wait on a bridge that cannot answer. */
  listening(): boolean;
}

/**
 * Wait `ms`, returning early if the signal aborts. Resolves either way.
 *
 * Goes through `setTimeout` even for `0`, which matters: a `Promise.resolve()` fast path is a
 * *microtask*, so a loop awaiting it never yields to the timer queue at all. See
 * {@link MIN_POLL_GAP_MS} for why the loop needs a real yield.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createBridge(deps: BridgeDeps): Bridge {
  const pollTimeoutSec = deps.pollTimeoutSec ?? POLL_TIMEOUT_SEC;
  const backoffMs = deps.backoffMs ?? backoffFor;
  const gapMs = deps.gapMs ?? MIN_POLL_GAP_MS;

  let controller: AbortController | null = null;
  /** The one parked question, if any. Set by `ask`, consumed by the loop or by `stop`. */
  let pending: ((answer: string | null) => void) | null = null;
  /**
   * Chats already reported as unrecognised.
   *
   * The "who is this?" notice is useful once per stranger and intolerable per message — and a
   * bot that has been found by a spammer would otherwise fill the terminal with it.
   */
  const announced = new Set<number>();

  const apiFor = (cfg: TelegramConfig, signal?: AbortSignal): TelegramDeps => ({
    config: cfg,
    fetch: deps.fetch,
    signal,
  });

  const say = async (text: string): Promise<boolean> => {
    const cfg = deps.loadConfig();
    if (!cfg.token || !cfg.chat) return false;
    try {
      // Its own deadline, and deliberately *not* the loop's signal: a message worth sending at
      // shutdown — the last reply, a denial notice — must not be cancelled by the shutdown
      // that prompted it.
      await sendMessage(cfg.chat, fitMessage(text), apiFor(cfg, deadline(SEND_TIMEOUT_MS)));
      return true;
    } catch (err) {
      if (!wasAborted(err)) {
        deps.notify(err instanceof Error ? err.message : String(err), "error");
      }
      return false;
    }
  };

  /** Route one update: an answer to a parked question, a message for the agent, or neither. */
  const route = (update: TelegramUpdate, cfg: TelegramConfig): void => {
    const msg = messageOf(update);
    const text = msg?.text?.trim();
    if (!msg || !text) return;

    // No owner configured. The bridge listens anyway and reports *who* wrote, because that is
    // how a user finds their own chat id — the job the deleted `list` action was really doing —
    // and it grants nothing: an unpaired message is never delivered.
    if (!cfg.chat) {
      if (!announced.has(msg.chat.id)) {
        announced.add(msg.chat.id);
        deps.notify(
          `a message arrived from ${describeSender(msg)}, and no chat is authorised. ` +
            `Run "/pi-telegram chat ${msg.chat.id}" to let that chat drive this session.`,
          "warning",
        );
      }
      return;
    }

    if (!matchesChat(msg, cfg.chat)) {
      if (!announced.has(msg.chat.id)) {
        announced.add(msg.chat.id);
        deps.notify(`ignoring messages from ${describeSender(msg)} — not the authorised chat.`, "warning");
      }
      return;
    }

    // A parked question wins over delivery. The owner's next message *is* the answer, including
    // when it is not the word "yes" — see `src/approve.ts`, which would rather deny on
    // something ambiguous than let it through, and must not also lose the text.
    if (pending) {
      const answer = pending;
      pending = null;
      answer(text);
      return;
    }
    deps.deliver(text);
  };

  const loop = async (signal: AbortSignal): Promise<void> => {
    /** `null` until the first poll, which is what {@link startingOffset} resolves. */
    let offset: number | null = null;
    let failures = 0;
    let warned = false;

    while (!signal.aborted) {
      const cfg = deps.loadConfig();
      // Re-read every pass: `/pi-telegram bridge off` and clearing the token both have to take
      // effect without a restart, and a config captured at start would ignore either.
      if (!canListen(cfg)) return;

      try {
        if (offset === null) offset = await startingOffset(apiFor(cfg, signal));
        const result = await poll(offset, apiFor(cfg, signal), pollTimeoutSec);
        offset = result.nextOffset;
        if (warned) {
          deps.notify("reconnected — listening again.", "info");
          warned = false;
        }
        failures = 0;
        for (const update of result.updates) route(update, cfg);
        await sleep(gapMs, signal);
      } catch (err) {
        if (signal.aborted || wasAborted(err)) return;
        failures += 1;
        if (failures >= WARN_AFTER_FAILURES && !warned) {
          warned = true;
          deps.notify(
            `not reaching Telegram (${err instanceof Error ? err.message : String(err)}). Still retrying.`,
            "warning",
          );
        }
        await sleep(backoffMs(failures), signal);
      }
    }
  };

  return {
    start(): void {
      if (controller) return;
      if (!canListen(deps.loadConfig())) return;
      const own = new AbortController();
      controller = own;
      // Fire and forget, but never unhandled: a rejection escaping here would surface as an
      // unhandled promise rejection in a session that has nothing to do with Telegram. The
      // loop is written not to throw; this is the backstop for when that stops being true.
      void loop(own.signal).catch((err: unknown) => {
        deps.notify(
          `bridge stopped: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      });
    },

    stop(): void {
      controller?.abort();
      controller = null;
      // Whoever is waiting on an answer will never get one now, and a gate left holding a
      // promise across shutdown is a tool call that never returns.
      const answer = pending;
      pending = null;
      answer?.(null);
    },

    say,

    async ask(question: string, timeoutMs: number, signal?: AbortSignal): Promise<Answer> {
      // Only one question at a time. A second would overwrite the first, and the first caller
      // would wait out its whole timeout for an answer that had already been given away. Reported
      // as `asked: false`, not as a silence: the owner was never asked this one.
      if (pending) return { asked: false };
      if (!(await say(question))) return { asked: false };

      const text = await new Promise<string | null>((resolve) => {
        // Four ways this ends — answered, timed out, turn cancelled, session stopped — and every
        // one of them has to resolve exactly once and leave `pending` clear. A second resolve is
        // harmless to the promise and not to `pending`: a stale continuation left in there would
        // silently swallow the *next* question's answer.
        let settled = false;
        const finish = (answer: string | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (pending === finish) pending = null;
          resolve(answer);
        };
        const onAbort = (): void => finish(null);
        const timer = setTimeout(() => finish(null), timeoutMs);
        if (signal?.aborted) return finish(null);
        signal?.addEventListener("abort", onAbort, { once: true });
        pending = finish;
      });
      return { asked: true, text };
    },

    listening(): boolean {
      return controller !== null;
    },
  };
}
