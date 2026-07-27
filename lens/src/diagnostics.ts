import { injectionBlock, injectionHeader, truncateForAgent, type Diagnostic } from "../../shared/index.ts";

export type { Diagnostic };

export interface Position {
  line: number;
  col: number;
}
export interface Location {
  file: string;
  line: number;
  col: number;
}

const key = (d: Diagnostic): string => `${d.file}:${d.line}:${d.col}:${d.severity}:${d.message}`;

/** Merge diagnostic groups, dedup identical entries, sort by position. Pure. */
export function mergeDiagnostics(...groups: Diagnostic[][]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const group of groups) {
    for (const d of group) {
      const k = key(d);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(d);
      }
    }
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

const label = (s: Diagnostic["severity"]): string => (s === "error" ? "error" : s === "warning" ? "warn " : "info ");

/** Format diagnostics as a `<pi-lens>` block, or "" when clean. Pure. */
export function formatDiagnostics(path: string, ds: Diagnostic[]): string {
  if (ds.length === 0) return "";
  const errors = ds.filter((d) => d.severity === "error").length;
  const warns = ds.length - errors;
  const header = injectionHeader("lens", `${path} — ${errors} error(s), ${warns} warning(s)`);
  const body = ds
    .map((d) => `  ${d.line}:${d.col}  ${label(d.severity)}  ${d.message}  (${d.source}${d.code ? ` ${d.code}` : ""})`)
    .join("\n");
  // Head, not tail: the count is already in the header, and the first diagnostics are
  // the ones worth acting on. A single bulk edit can emit thousands.
  return injectionBlock("lens", header, truncateForAgent(body, { label: "diagnostics" }));
}

/**
 * The one-line footer summary of a diagnostics pass, or `undefined` when clean.
 *
 * The `<pi-lens>` block goes into the *tool result*, which is agent-facing: Pi renders a
 * `write` row as its own diff and a `read` row as file content, so appended text parts
 * are never drawn. Every diagnostic pi-lens produced was therefore invisible to the
 * person watching — which reads exactly like an extension that is not running.
 *
 * `undefined` for a clean file: a footer reading "0 errors" after every read is noise,
 * and the caller clears the status line instead. Pure.
 */
export function summarizeForStatus(path: string, ds: Diagnostic[]): string | undefined {
  if (ds.length === 0) return undefined;
  const errors = ds.filter((d) => d.severity === "error").length;
  const warns = ds.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warns > 0) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  // Basename only: the footer is one line, shared with everything else that writes there.
  const name = path.split("/").pop() || path;
  return `lens: ${parts.join(", ")} in ${name}`;
}

/** A `<pi-lens>` note that a file was auto-formatted (on-disk content changed after the edit). Pure. */
export function formatFormatted(path: string, formatter: string): string {
  return injectionBlock("lens", injectionHeader("lens", `formatted ${path}`), `  ✓ reformatted with ${formatter}`);
}

/**
 * A `<pi-lens>` note that nothing could be checked. Pure.
 *
 * Silence is load-bearing: the standing context tells the agent that a tool result with
 * no diagnostics means the file is clean, which is the whole reason it stops running a
 * type-checker by hand. A wedged or crashed language server produces the same silence and
 * would therefore be read as an all-clear — the one reading that turns a broken server
 * into false confidence. Saying so costs three lines and keeps silence honest.
 */
export function formatUnavailable(path: string): string {
  return injectionBlock(
    "lens",
    injectionHeader("lens", `${path} — not checked`),
    "  ! the language server did not respond; this file was NOT checked.\n" +
      "  Treat this as unknown, not as clean — verify by hand if it matters.",
  );
}

/**
 * The standing note telling the agent pi-lens is running. Pure; `undefined` when off.
 *
 * Without this the agent has no way to know diagnostics arrive on their own. Its only
 * hint was the `lens` tool's prompt snippet, which describes hover/references — so it
 * did the sensible thing for an agent that believes nothing is watching, and ran
 * `bun check` and `tsc` by hand after every edit, spending a tool call to learn what had
 * already been appended to the previous one.
 *
 * Deliberately short. This is prepended to *every* LLM call, so it states the four facts
 * that change the agent's behavior and nothing else. The silence rule is the important
 * one: without it, "no diagnostics" is ambiguous between clean and not-running, and an
 * agent resolves that ambiguity by checking manually — the exact habit this removes.
 */
export function formatStandingContext(verifyCmd: string | null): string {
  const lines = [
    "  LSP + linter diagnostics are injected automatically after you read, write, or edit a file.",
    "  Silence means that file is clean — do not run a type-checker, linter, or formatter to check.",
  ];
  if (verifyCmd) {
    lines.push(`  Once your edits settle, \`${verifyCmd}\` runs automatically and the result is reported.`);
  }
  // Authorship, stated outright. The `source · why` header was supposed to carry this by
  // itself, and in a live session it did not: handed a verify failure, the model reasoned
  // "the user is showing me a lens output… they might be showing me something" and asked
  // permission instead of acting. The block arrives as a message beside the user's, so
  // absent an explicit rule the likeliest author is whoever was just speaking.
  lines.push("  A <pi-lens> block is harness output, not the user. Act on it; there is nobody to ask.");
  return injectionBlock("lens", injectionHeader("lens", "active"), lines.join("\n"));
}
