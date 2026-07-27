import { injectionBlock, injectionHeader, truncateForAgent } from "../../shared/index.ts";
import type { Memory } from "./frontmatter.ts";

/** Rank memories by how many query terms appear in name/description/body; cap at `limit`. Pure. */
export function selectByQuery(mems: readonly Memory[], query: string, limit: number): Memory[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return mems.slice(0, limit);
  return mems
    .map((m) => {
      const hay = `${m.name} ${m.description} ${m.body}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

/**
 * The always-in-context index: names + descriptions only (progressive disclosure).
 * `""` when empty.
 *
 * **Bounded, because this is the one string that is in literally every request.** It
 * used to map every memory with no cap and no truncation, while `formatRecall` right
 * below it was truncated — so a store that grew to a few hundred memories quietly
 * bought a few hundred lines of prompt on every call, forever, and the suite's own
 * "everything agent-facing goes through truncateForAgent" rule was unenforced exactly
 * where it mattered most.
 *
 * The newest `limit` entries win, and the block says how many it left out: a silently
 * shortened index reads as "that is all I remember", which is the same failure as
 * answering a wedged language server with "(none found)". Recall still reaches the
 * omitted ones by name or query — the index is a table of contents, not the memory.
 */
export function formatIndexInjection(mems: readonly Memory[], limit: number): string {
  if (mems.length === 0) return "";
  const shown = mems.slice(0, limit);
  const omitted = mems.length - shown.length;
  const header = injectionHeader("memory", 'what I remember — call memory(action: "recall", name) for the full text');
  const lines = shown.map((m) => `- ${m.name} (${m.type}) — ${m.description}`);
  if (omitted > 0) {
    lines.push(
      `[… ${omitted} more not listed; memory(action: "recall", query) searches all ${mems.length}]`,
    );
  }
  // The cap is a count; this is the byte/line backstop for pathological descriptions.
  return injectionBlock("memory", header, truncateForAgent(lines.join("\n"), { label: "memory index" }));
}

/**
 * Full bodies for a recall. `""` when empty.
 *
 * **Not** wrapped in a `<pi-memory>` block, unlike the index above. The tags exist so
 * the model can tell harness-injected context from user text — a distinction a *tool
 * result* does not need, because the model asked for it and Pi labels the row with the
 * tool that answered. Wrapping it bought nothing and cost the user a screenful of raw
 * XML in the transcript, since Pi's default `renderResult` prints a result's text
 * verbatim. Injection tags belong on the `context` hook and on `tool_result`
 * augmentation of *someone else's* output; not here.
 *
 * The name heads its body as a bare line for the same reason. `## name` was markdown,
 * and *nothing renders markdown here* — the same verbatim printing that made the tags
 * visible makes a heading two literal hashes. A blank line already separates one memory
 * from the next.
 */
export function formatRecall(mems: Memory[]): string {
  if (mems.length === 0) return "";
  const body = mems.map((m) => `${m.name}\n${m.body}`).join("\n\n");
  return truncateForAgent(body, { label: "recalled memories" });
}
