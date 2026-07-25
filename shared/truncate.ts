/**
 * One agent-facing rendering of Pi's truncation utilities.
 *
 * Pi's docs state that tools MUST truncate their output; the suite did not truncate
 * anywhere, so a large linter run, verify transcript, fetched page, or subagent log
 * entered the context whole.
 *
 * The cutting itself is Pi's — `truncateHead`/`truncateTail` are public exports of
 * `@earendil-works/pi-coding-agent`, already a peer dependency, and they handle the
 * line/byte limits and never-split-a-line rule. What they return is a struct, not a
 * string, so without a wrapper each of the seven extensions would invent its own
 * marker. This is that wrapper.
 *
 * Note the import path: these are **not** reachable from `@earendil-works/pi-agent-core`,
 * whose `exports` map exposes only `.`, `./node`, and `./package.json`.
 */
import {
  truncateHead,
  truncateTail,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

export interface TruncateOptions {
  /** Line ceiling. Defaults to Pi's `DEFAULT_MAX_LINES` (2000). */
  maxLines?: number;
  /** Byte ceiling. Defaults to Pi's `DEFAULT_MAX_BYTES` (50KB). */
  maxBytes?: number;
  /** Which end to keep. `"tail"` for output whose payload is last, e.g. test failures. */
  keep?: "head" | "tail";
  /** Named in the marker, so the agent knows *what* was shortened. */
  label?: string;
}

/**
 * Truncate agent-facing text, appending a marker naming what was dropped.
 *
 * Returns the input unchanged when it fits — no marker, no trailing-whitespace
 * change — because most outputs are small and must round-trip exactly.
 */
export function truncateForAgent(text: string, opts: TruncateOptions = {}): string {
  const limits = {
    maxLines: opts.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  const result = opts.keep === "tail" ? truncateTail(text, limits) : truncateHead(text, limits);
  if (!result.truncated) return text;

  const what = opts.label ? `${opts.label} ` : "";
  const where = opts.keep === "tail" ? "beginning" : "rest";
  const marker =
    `[… ${what}truncated: showing ${result.outputLines} of ${result.totalLines} lines ` +
    `(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}); ${where} omitted]`;

  return opts.keep === "tail" ? `${marker}\n${result.content}` : `${result.content}\n${marker}`;
}
