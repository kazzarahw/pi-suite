import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { LanguageToolchain } from "./toolchains.ts";

/** Availability of one tool binary referenced by the toolchains. */
export interface ToolStatus {
  bin: string;
  available: boolean;
}

/** Default `which`: is `bin` present in any `PATH` directory? (Unix; injectable for tests.) */
export function whichOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((d) => existsSync(join(d, bin)));
}

/** Probe each distinct tool binary the toolchains reference (LSP + linters + formatters) once. */
export function probeAvailability(
  toolchains: Record<string, LanguageToolchain>,
  which: (bin: string) => boolean,
): ToolStatus[] {
  const bins = new Set<string>();
  for (const tc of Object.values(toolchains)) {
    const lspBin = tc.lsp?.command[0];
    if (lspBin) bins.add(lspBin);
    for (const l of tc.linters) {
      const b = l.cmd("x")[0];
      if (b) bins.add(b);
    }
    const fmtBin = tc.formatter?.cmd("x")[0];
    if (fmtBin) bins.add(fmtBin);
  }
  return [...bins].sort().map((bin) => ({ bin, available: which(bin) }));
}

/** One-line health readout: which referenced tools are installed vs missing. */
export function formatHealth(statuses: ToolStatus[]): string {
  const have = statuses.filter((s) => s.available).map((s) => s.bin).sort();
  const miss = statuses.filter((s) => !s.available).map((s) => s.bin).sort();
  const parts = [`tools available: ${have.join(", ") || "none"}`];
  if (miss.length) parts.push(`missing: ${miss.join(", ")}`);
  return parts.join(" · ");
}

/** Compact health for a settings-panel subtitle: only what's missing (or "all tools installed"). */
export function formatHealthCompact(statuses: ToolStatus[]): string {
  const miss = statuses.filter((s) => !s.available).map((s) => s.bin).sort();
  return miss.length ? `missing tools: ${miss.join(", ")}` : "all tools installed";
}
