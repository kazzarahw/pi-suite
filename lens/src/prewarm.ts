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

/**
 * How long `git ls-files` gets before prewarm falls back to a shallow scan.
 *
 * This is a **synchronous** spawn on the `session_start` hook, so every millisecond it
 * takes is a millisecond Pi's startup is frozen — and with no bound it was "until git
 * returns", which on a cold cache, a huge repository, or a network filesystem is not a
 * number anyone chose. Prewarm is explicitly best-effort; timing out costs a warm server,
 * not a working one.
 */
const LS_FILES_TIMEOUT_MS = 5000;

/** List workspace files as absolute paths, cheaply: `git ls-files`, else a shallow scan of cwd + src/. */
export function listWorkspaceFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: LS_FILES_TIMEOUT_MS,
      // `execFileSync` pipes the child's stderr to the *parent's* unless told otherwise, so
      // starting Pi outside a repository printed git's `fatal: not a git repository` into
      // the terminal — from a path whose whole contract is to fall through quietly. The
      // failure is already handled below; its noise is not information.
      stdio: ["ignore", "pipe", "ignore"],
    });
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
