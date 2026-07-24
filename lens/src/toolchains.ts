import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ServerSpec } from "./lsp/config.ts";
import type { LinterSpec } from "./linters.ts";
import { RUFF, ESLINT, SHELLCHECK } from "./linters.ts";
import type { ExecFn } from "./exec.ts";

/** An in-place code formatter for a language. Success = exit 0; we diff bytes to detect changes. */
export interface FormatterSpec {
  name: string;
  /** Argv for the in-place formatter invocation. */
  cmd: (file: string) => string[];
}

/** The full per-language toolchain: language server, additive linters, and an optional formatter. */
export interface LanguageToolchain {
  lsp?: ServerSpec;
  linters: LinterSpec[];
  formatter?: FormatterSpec;
}

// Formatter specs (all in-place; each self-discovers the project's config when present).
export const PRETTIER: FormatterSpec = { name: "prettier", cmd: (f) => ["prettier", "--write", f] };
export const RUFF_FORMAT: FormatterSpec = { name: "ruff format", cmd: (f) => ["ruff", "format", f] };
export const RUSTFMT: FormatterSpec = { name: "rustfmt", cmd: (f) => ["rustfmt", f] };
export const GOFMT: FormatterSpec = { name: "gofmt", cmd: (f) => ["gofmt", "-w", f] };
export const SHFMT: FormatterSpec = { name: "shfmt", cmd: (f) => ["shfmt", "-w", f] };
export const TAPLO_FORMAT: FormatterSpec = { name: "taplo fmt", cmd: (f) => ["taplo", "fmt", f] };

const tsLsp = (languageId: string): ServerSpec => ({
  command: ["typescript-language-server", "--stdio"],
  languageId,
});

/**
 * The built-in per-language toolchains, keyed by lowercased file extension. Each tool runs with its
 * own defaults and auto-layers the project's config (tsconfig/pyproject/…) when present. Coverage is
 * gated at runtime on the binary being installed (see health.ts); missing tools are skipped silently.
 */
export const DEFAULT_TOOLCHAINS: Record<string, LanguageToolchain> = {
  ts: { lsp: tsLsp("typescript"), linters: [ESLINT], formatter: PRETTIER },
  tsx: { lsp: tsLsp("typescriptreact"), linters: [ESLINT], formatter: PRETTIER },
  js: { lsp: tsLsp("javascript"), linters: [ESLINT], formatter: PRETTIER },
  jsx: { lsp: tsLsp("javascriptreact"), linters: [ESLINT], formatter: PRETTIER },
  mjs: { lsp: tsLsp("javascript"), linters: [ESLINT], formatter: PRETTIER },
  cjs: { lsp: tsLsp("javascript"), linters: [ESLINT], formatter: PRETTIER },
  py: {
    lsp: { command: ["pyright-langserver", "--stdio"], languageId: "python" },
    linters: [RUFF],
    formatter: RUFF_FORMAT,
  },
  rs: { lsp: { command: ["rust-analyzer"], languageId: "rust" }, linters: [], formatter: RUSTFMT },
  go: { lsp: { command: ["gopls"], languageId: "go" }, linters: [], formatter: GOFMT },
  sh: {
    lsp: { command: ["bash-language-server", "start"], languageId: "shellscript" },
    linters: [SHELLCHECK],
    formatter: SHFMT,
  },
  bash: {
    lsp: { command: ["bash-language-server", "start"], languageId: "shellscript" },
    linters: [SHELLCHECK],
    formatter: SHFMT,
  },
  json: {
    lsp: { command: ["vscode-json-language-server", "--stdio"], languageId: "json" },
    linters: [],
    formatter: PRETTIER,
  },
  jsonc: {
    lsp: { command: ["vscode-json-language-server", "--stdio"], languageId: "jsonc" },
    linters: [],
    formatter: PRETTIER,
  },
  yaml: {
    lsp: { command: ["yaml-language-server", "--stdio"], languageId: "yaml" },
    linters: [],
    formatter: PRETTIER,
  },
  yml: {
    lsp: { command: ["yaml-language-server", "--stdio"], languageId: "yaml" },
    linters: [],
    formatter: PRETTIER,
  },
  toml: { lsp: { command: ["taplo", "lsp", "stdio"], languageId: "toml" }, linters: [], formatter: TAPLO_FORMAT },
  md: { linters: [], formatter: PRETTIER },
  markdown: { linters: [], formatter: PRETTIER },
};

/** Resolve the toolchain for a file (defaults shallow-merged with any per-ext overrides), or null. */
export function toolchainFor(
  path: string,
  overrides?: Record<string, Partial<LanguageToolchain>>,
): LanguageToolchain | null {
  const ext = extname(path).slice(1).toLowerCase();
  const base = DEFAULT_TOOLCHAINS[ext];
  const ov = overrides?.[ext];
  if (!base && !ov) return null;
  return { linters: [], ...(base ?? {}), ...(ov ?? {}) };
}

/** Derive the ext→LSP-server map the LSP manager keys on, from the toolchains. */
export function lspServers(overrides?: Record<string, Partial<LanguageToolchain>>): Record<string, ServerSpec> {
  const out: Record<string, ServerSpec> = {};
  const exts = new Set([...Object.keys(DEFAULT_TOOLCHAINS), ...Object.keys(overrides ?? {})]);
  for (const ext of exts) {
    const tc = toolchainFor(`x.${ext}`, overrides);
    if (tc?.lsp) out[ext] = tc.lsp;
  }
  return out;
}

/**
 * Run a formatter in place and report whether the file's bytes changed (drives the LSP re-sync and
 * the "reformatted" note). Never throws — a missing binary, non-zero exit, or unreadable file → no change.
 */
export async function runFormatter(
  path: string,
  spec: FormatterSpec,
  exec: ExecFn,
  signal?: AbortSignal,
): Promise<{ changed: boolean }> {
  let before: string;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    return { changed: false };
  }
  const [cmd, ...args] = spec.cmd(path);
  if (!cmd) return { changed: false };
  try {
    const { code } = await exec(cmd, args, { signal });
    if (code !== 0) return { changed: false };
  } catch {
    return { changed: false };
  }
  try {
    return { changed: readFileSync(path, "utf8") !== before };
  } catch {
    return { changed: false };
  }
}
