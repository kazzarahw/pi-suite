/**
 * What goes back to Telegram when the agent stops, and when.
 *
 * Pure, because the decision is easy to get subtly wrong and impossible to test through hooks:
 * `agent_settled` carries **no payload** — it is `{ type: "agent_settled" }` and nothing else —
 * so the text has to be captured from `message_end` as it streams past and held until settle.
 * Two hooks and a piece of mutable state between them is exactly the shape that ends up
 * relaying the wrong turn's answer, or last turn's answer twice.
 */
import type { ReplyMode } from "./config.ts";

/** The shape of an assistant message, as much of it as this needs. */
interface MaybeAssistant {
  role?: unknown;
  content?: unknown;
}

/**
 * The prose of an assistant message, or `null` when it has none.
 *
 * `null` for a message that is only tool calls and thinking, which is most of them mid-turn:
 * `AssistantMessage.content` is `(TextContent | ThinkingContent | ToolCall)[]`, and relaying a
 * turn's worth of empty strings would send a stream of blank messages to someone's phone.
 * Thinking is excluded rather than merely unhandled — it is not the answer, and it is not
 * something to push to a phone.
 */
export function assistantText(message: unknown): string | null {
  const m = message as MaybeAssistant | undefined;
  if (m?.role !== "assistant") return null;
  // A string content is not a shape the current types produce, but `spawn/src/runner.ts` reads
  // one defensively off the same event and it costs a line to accept.
  if (typeof m.content === "string") return m.content.trim() || null;
  if (!Array.isArray(m.content)) return null;
  const text = m.content
    .filter((part): part is { type: "text"; text: string } => {
      const p = part as { type?: unknown; text?: unknown };
      return p?.type === "text" && typeof p.text === "string";
    })
    .map((part) => part.text)
    .join("")
    .trim();
  return text || null;
}

/**
 * Should this settle be relayed to Telegram?
 *
 * `telegram` is the default and the interesting case: the answer goes back only to a turn
 * Telegram started. Someone at the keyboard is already reading the reply, and mirroring every
 * local answer to their phone is notification spam that trains them to ignore the one that
 * matters — while someone who asked from a phone has nowhere else to see it.
 */
export function shouldRelay(mode: ReplyMode, startedByTelegram: boolean): boolean {
  if (mode === "off") return false;
  return mode === "always" || startedByTelegram;
}
