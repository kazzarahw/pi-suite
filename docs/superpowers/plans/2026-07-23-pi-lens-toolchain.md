# pi-lens Toolchain — Build Spec (enhancement)

> Design/implementation spec. Decisions, responsibilities, interfaces, build
> order, acceptance criteria. No function bodies. Extends the v1 spec
> (`2026-07-20-pi-lens.md`); read that first. This is additive — nothing in v1's
> behavior changes for TS/JS or Python beyond being re-homed in the registry.

**Goal:** Broad **out-of-the-box** language coverage. Most languages the user works
in should get working pi-lens feedback (LSP diagnostics + linters, and optionally
auto-format) with **zero project config**, while each tool still auto-layers the
project's own settings (`tsconfig.json`, `pyproject.toml`, `rustfmt.toml`, …) when
present. Unify LSP + linters + a new **formatter** dimension into one per-language
**toolchain registry**, add opt-in auto-format (default off), and a `/pi-lens`
**health readout** so "is my setup working here?" is answerable at a glance.

**Non-goal:** a Helix-style verbose per-language config surface. Coverage and
graceful degradation matter; the override mechanism stays minimal (§Decision 6).

**Architecture:** Collapse the two parallel maps that exist today —
`lsp/config.ts:DEFAULT_SERVERS` (ext→LSP) and `linters.ts:lintersFor` (ext→linters)
— into one `DEFAULT_TOOLCHAINS: ext → { lsp?, linters[], formatter? }`. The
`tool_result` hook resolves one toolchain per file and runs LSP + linters (as
today) plus, on write/edit when enabled, the formatter. A small `health` module
probes tool availability for the command readout.

**Tech Stack:** unchanged — TypeScript/ESM, Bun + `bun test`, `node:child_process`,
`@earendil-works/pi-*` peers.

## Global Constraints

See `pi-shared/HOUSE-STYLE.md` and the v1 spec. Application:
- Still **one tool** `lens`; formatters/linters remain **hook-only** (no new tool).
- The enforcement dial is unchanged. `autoFormat` is a **domain sub-flag**, not a
  new `mode` level (house-style §7 allows sub-flags). Default **off**.
- Injections stay `<pi-lens>` blocks. No new events required (a reformat may reuse
  a short injected note; no new `domain:event`).

## Design Decisions

1. **One per-language toolchain, one lookup.** Introduce
   `LanguageToolchain = { lsp?: ServerSpec; linters: LinterSpec[]; formatter?: FormatterSpec }`
   and `DEFAULT_TOOLCHAINS: Record<ext, LanguageToolchain>`. `toolchainFor(path)`
   returns the whole toolchain for a file (or `null` for an unknown extension).
   `ServerSpec`/`LinterSpec` keep their current shapes; the manager keeps keying
   LSP servers by command. Adding a language = adding one registry entry.

2. **Coverage-first default registry.** Ship defaults for the confirmed set. Exact
   commands (each self-discovers project config; formatters are in-place):

   | Ext | LSP | Linter (additive) | Formatter (default off) |
   |---|---|---|---|
   | ts, tsx, js, jsx, mjs, cjs | `typescript-language-server --stdio` | `eslint --format json` *(config-only)* | `prettier --write` |
   | py | `pyright-langserver --stdio` | `ruff check --output-format json --quiet` | `ruff format` |
   | rs | `rust-analyzer` | *(rust-analyzer/clippy diags)* | `rustfmt` |
   | go | `gopls` | *(gopls vet)* | `gofmt -w` |
   | sh, bash | `bash-language-server start` | `shellcheck --format=json` | `shfmt -w` |
   | json | `vscode-json-language-server --stdio` | — | `prettier --write` |
   | yaml, yml | `yaml-language-server --stdio` | — | `prettier --write` |
   | toml | `taplo lsp stdio` | — | `taplo fmt` |
   | md, markdown | — | — | `prettier --write` |

   `languageId` per ext as today (typescript/typescriptreact/javascript/python/rust/go/shellscript/json/yaml/toml/markdown).

3. **LSP is primary; standalone linters are additive, never duplicative.** Only
   attach a standalone linter where it surfaces what the LSP doesn't (ruff's
   style/lint vs pyright's type-only diagnostics; shellcheck; eslint's project
   rules). `mergeDiagnostics` already dedups identical `file:line:col:sev:msg`, so
   overlap is safe, but the registry should avoid pointless double-runs.

4. **Formatters: opt-in, write/edit-only, mutation-aware.** New
   `formatter?: FormatterSpec` (in-place; success = exit 0). On a **write/edit**
   `tool_result` (never `read`), when `config.autoFormat` is on and the file's
   toolchain has a formatter: run it → if bytes changed, re-read + `didChange` the
   formatted text to the LSP → then gather diagnostics/linters on the **formatted**
   content → inject a one-line `<pi-lens>` note that the file was reformatted (the
   on-disk file now differs from what the edit tool wrote — transparency). Skip the
   re-sync/note when the formatter is a no-op (no churn). Abort-aware via
   `ctx.signal`. The reformat is part of the same turn, so pi-git's next checkpoint
   captures it and `/fork` reverts it — no special handling.

5. **Availability probing + `/pi-lens` health line.** Probe each toolchain tool's
   binary on `PATH` once per session (cached). `/pi-lens` (no-arg) appends an
   active/missing readout, e.g. `active: ts, py, rust · missing: gopls, shellcheck`.
   Missing tools are skipped silently at runtime (existing graceful-degrade); the
   health line is the only place absence is surfaced. This is the answer to "does
   my setup work out of the box here?"

6. **Overrides stay minimal (coverage over override).** Per-project *tool* settings
   come free (each tool discovers its own config). User-facing config is limited to
   `autoFormat on|off` (new), plus the existing `verify <cmd>` and `mode`. A
   `toolchains` override map (ext → partial `LanguageToolchain`, deep-merged over
   defaults, for adding/replacing a language or pinning a command) is **specced but
   deferred** — not needed for the coverage goal; add if a real need appears.

### To resolve during implementation
- Confirm each default command's exact flags against the installed tool version
  (e.g. `pyright-langserver` vs `pyright --langserver`; `shfmt -w` stdin behavior).
- Decide whether eslint runs at all without a config (it no-ops) or is gated on a
  detected eslint config to avoid a wasted spawn per JS edit.
- Whether Rust/Go want a standalone linter beyond the LSP (likely no for v1).

## File Structure & Responsibilities (deltas vs v1)

| File | Change |
|---|---|
| `src/toolchains.ts` | **NEW.** `LanguageToolchain`, `FormatterSpec`, `DEFAULT_TOOLCHAINS`, `toolchainFor(path, overrides?)`, `runFormatter(...)`. Absorbs `DEFAULT_SERVERS` + the linter specs. |
| `src/lsp/config.ts` | `ServerSpec` type stays; `DEFAULT_SERVERS` moves into `toolchains.ts` (or re-exports for the manager). |
| `src/linters.ts` | `LinterSpec` + `runLinters` stay; the concrete specs (RUFF, +new) move into the registry. |
| `src/health.ts` | **NEW.** `probeAvailability(...)`, `formatHealth(...)`; injectable `which`. |
| `src/config.ts` | add `autoFormat: boolean` (default `false`); (deferred) optional `toolchains`. |
| `index.ts` | `tool_result` hook: resolve via `toolchainFor`; add the format step (write/edit + `autoFormat`), LSP re-sync, reformat note. |
| `src/command.ts` | add `autoformat on\|off`; append the health line to the no-arg readout. |
| `test/*` | new: registry lookup, `FormatterSpec` argv, `runFormatter` changed-bytes gating, availability probe (injected `which`), health formatting. |

## Interfaces / Contracts

```typescript
// toolchains.ts
interface FormatterSpec {
  name: string;                          // "prettier", "ruff format", "gofmt"
  cmd: (file: string) => string[];       // in-place formatter argv; success = exit 0
}
interface LanguageToolchain {
  lsp?: ServerSpec;                      // ServerSpec = { command: string[]; languageId: string }
  linters: LinterSpec[];                 // LinterSpec = { name; cmd; parse } (unchanged)
  formatter?: FormatterSpec;
}
const DEFAULT_TOOLCHAINS: Record<string, LanguageToolchain>;      // keyed by lowercased ext
function toolchainFor(path: string, overrides?: Record<string, Partial<LanguageToolchain>>): LanguageToolchain | null;

// runs the formatter in place; reports whether the file's bytes changed (drives re-sync + note)
function runFormatter(path: string, spec: FormatterSpec, exec: ExecFn, signal?: AbortSignal): Promise<{ changed: boolean }>;

// health.ts
type ToolKind = "lsp" | "linter" | "formatter";
interface ToolStatus { ext: string; kind: ToolKind; name: string; available: boolean; }
function probeAvailability(toolchains: Record<string, LanguageToolchain>, which: (bin: string) => boolean): ToolStatus[];
function formatHealth(statuses: ToolStatus[]): string;           // "active: ts, py · missing: gopls"

// config.ts
interface LensConfig { mode: Mode; verifyCmd: string; autoFormat: boolean; /* deferred: toolchains? */ }
```

## Build Sequence

- [ ] **1 · Registry unification** — introduce `toolchains.ts`; move `DEFAULT_SERVERS` + the ruff spec in; `toolchainFor`. Manager + `tool_result` hook consume `toolchainFor`. Accept: TS/JS diagnostics and Python ruff behave exactly as v1; `toolchainFor("a.ts")`/`("a.py")` return the right tools, `("a.xyz")` → `null`.
- [ ] **2 · Registry breadth** — add rs/go/sh/json/yaml/toml/md entries per Decision 2. Accept: each ext resolves to its documented tools; `languageId` correct.
- [ ] **3 · Availability + health** — `probeAvailability` (injected `which`) + `formatHealth`; wire into `/pi-lens` no-arg. Accept: with a fake `which`, active/missing split is correct; command output includes the line.
- [ ] **4 · Formatter runner** — `FormatterSpec` + `runFormatter` with changed-bytes gating, abort-aware. Accept (unit): a fixture "needs formatting" file reports `changed: true` and is rewritten; an already-formatted file reports `changed: false` and is untouched.
- [ ] **5 · Auto-format wiring** — in `tool_result` (write/edit only, `autoFormat` on): format → re-read → `didChange` → diagnostics on formatted bytes → inject reformat note. Accept (live): with `autoFormat` on, an edit leaving unformatted code is reformatted, a `<pi-lens>` "reformatted" note appears, and diagnostics reflect the formatted file; with it off, nothing formats.
- [ ] **6 · Config + command** — `autoFormat` in config (default off); `/pi-lens autoformat on|off`. Accept: toggle persists to `pi-lens.json`; default off; invalid arg errors.

## Test Strategy

Pure units carry it, as in v1: registry lookup (`toolchainFor`), `FormatterSpec`
argv, `runFormatter` changed-bytes detection (temp-file fixtures), availability
probe (injected `which`), health formatting. The format→LSP-resync path and real
formatters are proven in live tmux smoke (the suite's pattern), not unit-mocked.

## Risks / Notes

- **Auto-format mutates files after the edit tool ran** — the agent's view can
  diverge from disk. Mitigations: default **off**; always inject the "reformatted"
  note; reversible via pi-git/`/fork`. This is the main reason it's opt-in.
- **Format→diagnostics ordering** — must `didChange` the formatted text *before*
  pulling diagnostics, or diagnostics reflect pre-format bytes.
- **Double-reporting** LSP vs standalone linter — keep linters complementary; lean
  on `mergeDiagnostics` dedup; don't attach a linter that only repeats the LSP.
- **Availability varies by machine** — degrade silently at runtime; surface only in
  the health line; never hard-fail a read/edit because a tool is missing (v1 rule).
- **Config-only tools** (eslint, json/yaml servers) — "active" in health only when
  the project actually configures them; document so a missing eslint config doesn't
  read as broken.
- **Per-tool invocation quirks** — stdin vs in-place, `-w` flags, langserver
  entrypoints differ; encode each in its spec and verify against installed versions
  (see "To resolve").
- **Interaction with warm-gating** (the 2026-07-23 manager fix): unchanged — the
  registry only feeds the manager the same `ServerSpec`; `ready()`'s warm wait still
  applies per LSP server.
