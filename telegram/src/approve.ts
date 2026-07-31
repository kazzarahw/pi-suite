/**
 * The approval gate's decisions, as pure functions.
 *
 * Pi exposes no permission hook to extensions — `ExtensionAPI` has `on("tool_call", …)` and
 * nothing about the built-in permission dialog — so this is **pi-telegram's own gate over
 * `tool_call`**, not a remote control for Pi's. Worth being exact about, because the two look
 * alike from the outside and only one of them is a security boundary: Pi's permission system
 * stands in front of the tool regardless, and this asks a second question over Telegram first.
 *
 * The logic lives here rather than inline in `index.ts` for the reason `plan/src/gate.ts` gives
 * about its own policy: a decision reachable only by driving a hook with the right fake context
 * gets covered incidentally, if at all. As pure functions these are one-line tests.
 */
import { EDIT_TOOLS, OPAQUE_WRITE_TOOLS, editedPath } from "../../shared/tool-input.ts";
import type { ApproveMode } from "./config.ts";

/**
 * The tools `approve: "writes"` covers.
 *
 * Composed from `shared/tool-input.ts` rather than listed here. That module exists because
 * pi-git and pi-lens once disagreed about which tools write, and a file edited through the key
 * one of them did not read went unrecorded; a third opinion in this file is how the next
 * version of that arrives. `OPAQUE_WRITE_TOOLS` is `bash`, which matters more here than
 * anywhere: pi-plan's edit gate documents at length that it cannot see a write through bash,
 * and an approval gate that skipped `bash` would be asking about the careful half of the work
 * while waving through `rm -rf`.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([...EDIT_TOOLS, ...OPAQUE_WRITE_TOOLS]);

/** Does this call have to be approved before it runs? */
export function needsApproval(mode: ApproveMode, toolName: string): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return WRITE_TOOLS.has(toolName);
}

/** How much of a command or path to put in the question. Phone screens are small. */
const DETAIL_CHARS = 300;

const clip = (s: string, n = DETAIL_CHARS): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The interesting half of a tool call, for someone reading it on a phone with no transcript.
 *
 * A bare tool name is not enough to approve on — "allow bash?" is a question nobody can answer
 * responsibly — so the payload has to be in the message. `editedPath` handles both spellings of
 * the path key, which is the whole reason it is shared.
 */
export function describeToolCall(input: unknown): string {
  const i = input as { command?: unknown; pattern?: unknown } | undefined;
  if (typeof i?.command === "string") return clip(i.command);
  const path = editedPath(input);
  if (path) return clip(path);
  if (typeof i?.pattern === "string") return clip(i.pattern);
  return "(no details)";
}

/** The question sent to the owner chat. */
export function approvalQuestion(toolName: string, input: unknown): string {
  return (
    `${toolName}\n${describeToolCall(input)}\n\n` +
    `Reply "yes" to allow, or anything else to refuse.`
  );
}

export type Verdict = "approved" | "denied" | "unclear" | "unanswered";

const YES = new Set(["y", "yes", "ok", "okay", "sure", "go", "allow", "approve", "approved", "👍"]);
const NO = new Set(["n", "no", "nope", "stop", "deny", "denied", "cancel", "abort", "👎"]);

/**
 * Read an answer, and refuse to be generous about it.
 *
 * `unanswered` and `unclear` are separated because they are different things to *tell the
 * agent*, but both refuse: an approval gate that treats silence or ambiguity as consent is not
 * a gate. The asymmetry is deliberate in the other direction too — the yes list is short and
 * exact, while anything at all counts as no, because the cost of misreading is a refused tool
 * call the agent can raise again, against a change nobody agreed to.
 *
 * A message that was meant as steering rather than an answer therefore lands as a refusal. That
 * is the right way round: it stops the call, and {@link refusalReason} quotes the text back so
 * the agent can act on what was actually said.
 */
export function readVerdict(answer: string | null): Verdict {
  if (answer === null) return "unanswered";
  const word = answer.trim().toLowerCase().replace(/[.!]+$/, "");
  if (YES.has(word)) return "approved";
  if (NO.has(word)) return "denied";
  return "unclear";
}

/**
 * Why the call did not happen, told to the agent.
 *
 * **Leads with the outcome**, per the precedent `plan/src/gate.ts` sets and the dogfooding
 * behind it: blocking stops the call, but from the model's side the call has already been made,
 * payload and all, and Pi renders it that way. An agent given only the reason inferred that the
 * write had landed, said so, and went looking for a file that did not exist.
 */
export function refusalReason(toolName: string, verdict: Verdict, answer: string | null): string {
  const head = `[pi-telegram] this ${toolName} call did NOT run — nothing was changed.`;
  switch (verdict) {
    case "denied":
      return `${head} It was refused from Telegram. Do not retry it; ask what to do instead.`;
    case "unclear":
      return (
        `${head} Telegram was asked to approve it and replied "${clip(answer ?? "", 200)}", ` +
        `which is not an approval. Treat that as the instruction and act on it.`
      );
    default:
      return (
        `${head} Telegram was asked to approve it and no answer came back before the deadline. ` +
        `Say what you were about to do and wait, rather than trying again.`
      );
  }
}
