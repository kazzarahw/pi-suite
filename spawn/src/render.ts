import type { SpawnEvent } from "./runner.ts";

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One concise widget line for a streaming subagent event. Pure. */
export function eventToLine(e: SpawnEvent): string {
  switch (e.kind) {
    case "tool":
      return `⚙ ${e.text}`;
    case "text":
      return truncate(e.text.replace(/\s+/g, " ").trim(), 88);
    case "final":
      return "✓ done";
    case "error":
      return `✗ ${e.text}`;
  }
}
