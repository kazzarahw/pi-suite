import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { LanguageToolchain } from "./toolchains.ts";

/**
 * Pick one representative workspace file per distinct, installed language server — the files to `didOpen`
 * on session_start so the server does its project load in the background, before the agent's first read.
 * Pure; inject `which` + the candidate `files`. Each distinct server binary is probed at most once.
 */
export function discoverWarmTargets(
  toolchains: Record<string, LanguageToolchain>,
  which: (bin: string) => boolean,
  files: string[],
): string[] {
  const installed = new Map<string, boolean>(); // server-command key → binary on PATH?
  const chosen = new Set<string>(); // server keys we've already picked a file for
  const targets: string[] = [];
  for (const file of files) {
    const lsp = toolchains[extname(file).slice(1).toLowerCase()]?.lsp;
    const bin = lsp?.command[0];
    if (!lsp || !bin) continue;
    const key = lsp.command.join(" ");
    if (chosen.has(key)) continue;
    let ok = installed.get(key);
    if (ok === undefined) {
      ok = which(bin);
      installed.set(key, ok);
    }
    if (!ok) continue;
    chosen.add(key);
    targets.push(file);
  }
  return targets;
}

/** List workspace files as absolute paths, cheaply: `git ls-files`, else a shallow scan of cwd + src/. */
export function listWorkspaceFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const rel = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (rel.length > 0) return rel.map((r) => resolve(cwd, r));
  } catch {
    /* not a git repo / git unavailable — fall through */
  }
  const out: string[] = [];
  for (const dir of [cwd, join(cwd, "src")]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) out.push(join(dir, entry.name));
      }
    } catch {
      /* dir missing */
    }
  }
  return out;
}
