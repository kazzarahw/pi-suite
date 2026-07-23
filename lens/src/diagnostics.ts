import { injectionBlock, injectionHeader, type Diagnostic } from "pi-shared";

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
  return injectionBlock("lens", header, body);
}

/** A `<pi-lens>` note that a file was auto-formatted (on-disk content changed after the edit). Pure. */
export function formatFormatted(path: string, formatter: string): string {
  return injectionBlock("lens", injectionHeader("lens", `formatted ${path}`), `  ✓ reformatted with ${formatter}`);
}
