import { injectionBlock, injectionHeader } from "pi-shared";
import type { Memory } from "./frontmatter.ts";

/** Rank memories by how many query terms appear in name/description/body; cap at `limit`. Pure. */
export function selectByQuery(mems: Memory[], query: string, limit: number): Memory[] {
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

/** The always-in-context index: names + descriptions only (progressive disclosure). "" when empty. */
export function formatIndexInjection(mems: Memory[]): string {
  if (mems.length === 0) return "";
  const header = injectionHeader("memory", "what I remember — call memory_recall(name) for the full text");
  const body = mems.map((m) => `- ${m.name} (${m.type}) — ${m.description}`).join("\n");
  return injectionBlock("memory", header, body);
}

/** Full bodies for a recall. "" when empty. */
export function formatRecall(mems: Memory[]): string {
  if (mems.length === 0) return "";
  const header = injectionHeader("memory", "recalled");
  const body = mems.map((m) => `## ${m.name}\n${m.body}`).join("\n\n");
  return injectionBlock("memory", header, body);
}
