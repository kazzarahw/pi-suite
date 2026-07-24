# pi-suite Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plan format note:** per the repo owner's standing preference, this plan specifies
> decisions, file responsibilities, exact interfaces, and acceptance criteria — it does
> **not** pre-write function or test bodies. Interface signatures are contracts and are
> exact; behavior is described as bullets. Write the code at implementation time.

**Goal:** Consolidate the eight `pi-*` repos into one `pi-suite` repo and one Pi package, eliminating the live `--omit=dev` install break and the sevenfold helper duplication, while preserving behavior and full git history.

**Architecture:** One package declaring seven `pi.extensions` entry points, sharing a `shared/` module by relative import. History arrives via `git subtree add` per repo. Three duplicated helpers (config loader, settings panel, exec) collapse into `shared/`. Three new test layers — wiring, contract, install-smoke — cover what has never been covered.

**Tech Stack:** TypeScript (ESM, `.ts` extensions in imports), Bun (runtime + `bun test`), Pi extension API (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `typebox` as peerDeps), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-24-pi-suite-consolidation-design.md` (decisions D1–D9).

## Global Constraints

- **Behavior-preserving**, with exactly two sanctioned changes (spec D5): all seven extensions honor `PI_CODING_AGENT_DIR`; `execFile` `maxBuffer` standardizes at **64MB** (`64 * 1024 * 1024`).
- **Pre-existing test bodies do not change**, except the forced config/exec merges (spec D8). No net loss of distinct assertions.
- **Peer dependencies stay peers** at `"*"`: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`. Never bundle them.
- **No `devDependency` may be imported at runtime.** This is the P0 being fixed; reintroducing it fails Task 8.
- **Extension load order is fixed** (spec D6): `memory, todo, git, consult, spawn, browser, lens`.
- **Import boundary** (spec D7): an extension directory may import only from its own subtree, `shared/`, `node:*`, and the peer packages.
- **License:** AGPL-3.0. **Package is `private: true`** (installed from git, never published to npm).
- **Out of scope** — do not implement here: output truncation, LSP `request()` timeout, `cwd` bug fixes, git restore-undo/ref GC, memory caching, trust checks, spawn timeouts, `settings.json` migration, `mode: "block"` semantics, event wiring, `promptGuidelines`, custom rendering.

---

## File Structure

```
pi-suite/
├── package.json                  # single manifest, 7 entry points in D6 order
├── tsconfig.json                 # single strict ESM/bundler config
├── .gitignore  LICENSE  README.md
├── docs/
│   ├── HOUSE-STYLE.md            # relocated from pi-shared/
│   └── superpowers/{specs,plans}/
├── shared/                       # was pi-shared; now an internal module
│   ├── index.ts                  # barrel: re-exports mode/events/tags/surface
│   ├── mode.ts events.ts tags.ts # unchanged contract types
│   ├── surface.ts        NEW     # machine-readable tool/command surface map
│   ├── config.ts         NEW     # generic loader (7 copies collapse here)
│   ├── settings-panel.ts NEW     # openSettingsPanel (7 copies collapse here)
│   ├── exec.ts           NEW     # ExecFn + defaultExec (4 copies collapse here)
│   └── test/
│       ├── harness.ts    NEW     # fake ExtensionAPI for wiring tests
│       ├── config.test.ts NEW    # merged from 7 near-identical suites
│       ├── exec.test.ts  NEW     # merged
│       └── tags.test.ts  NEW     # pi-shared shipped zero tests
├── consult/ git/ lens/ memory/ spawn/ todo/ browser/
│   ├── index.ts  src/  test/     # internals unchanged
│   └── test/wiring.test.ts NEW   # co-located; one per extension
├── test/
│   ├── contract.test.ts  NEW     # surface + event-vocabulary drift guard
│   └── boundaries.test.ts NEW    # D7 enforcement
├── scripts/smoke-install.sh NEW  # clean-clone --omit=dev load check
└── .github/workflows/ci.yml NEW
```

**Refinement to spec D7 (flagged):** the import boundary is implemented as a **test**
(`test/boundaries.test.ts`) rather than an ESLint rule. The repo has no ESLint config
today, and pi-lens gates its ESLint linter on config presence — adding one would change
pi-lens's own behavior, violating the behavior-preserving constraint. A test achieves
identical enforcement, runs in the same `bun test`, and needs no new toolchain.

---

## Interfaces

These are contracts. Later tasks depend on these exact names and types.

### `shared/exec.ts`

```ts
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;   // merged over process.env
  signal?: AbortSignal;
}
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: ExecOptions,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const MAX_BUFFER: number;   // 64 * 1024 * 1024 (D5)
export const defaultExec: ExecFn;  // resolves (never rejects); maps error → exit code
```

### `shared/config.ts`

```ts
export interface ConfigSpec<T> {
  name: string;                          // "lens" → <agentDir>/pi-lens.json
  defaults: T;
  parse(raw: unknown, defaults: T): T;   // per-extension field validation
}
export function agentDir(): string;                    // PI_CODING_AGENT_DIR ?? ~/.pi/agent
export function configPath(name: string): string;
export function loadConfig<T>(spec: ConfigSpec<T>, path?: string): T;   // never throws
export function saveConfig<T>(spec: ConfigSpec<T>, cfg: T, path?: string): void;
```

The optional `path` override is **required**, not incidental: all seven existing config
suites pass an explicit tmp path, and the merged suite depends on it.

### `shared/settings-panel.ts`

```ts
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";

export function openSettingsPanel(
  ctx: ExtensionCommandContext,
  title: string,
  subtitle: string,
  items: SettingItem[],
  apply: (id: string, value: string) => void,
): Promise<void>;
```

### `shared/surface.ts`

```ts
export interface ExtensionSurface {
  readonly dir: string;                  // "lens" — also the directory name
  readonly command: string;              // "pi-lens"
  readonly tools: readonly string[];      // [] for pi-git (hooks only)
}
export const SURFACE: readonly ExtensionSurface[];
```

Single source of truth for the "seven tools, tight agent surface" claim. The contract
test asserts the live registry matches it; `docs/HOUSE-STYLE.md` is checked against it
rather than being the source.

### `shared/test/harness.ts`

```ts
export interface FakeCtx {
  hasUI: boolean;
  mode: "tui" | "print" | "json" | "rpc";
  cwd: string;
  signal?: AbortSignal;
  sessionManager: { getCwd(): string; getBranch(): unknown[]; getLeafEntry(): unknown };
  ui: {
    setStatus(id: string, text?: string): void;
    setWidget(id: string, lines?: string[]): void;
    notify(msg: string, level?: string): void;
    custom(render: unknown): Promise<unknown>;
  };
}

export interface FakeApi {
  tools: Map<string, { name: string; description: string; promptSnippet?: string;
                       parameters: unknown; execute: (...a: unknown[]) => Promise<unknown> }>;
  commands: Map<string, { description?: string; handler: (...a: unknown[]) => Promise<void>;
                          getArgumentCompletions?: (prefix: string) => unknown }>;
  hooks: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  busHandlers: Map<string, Array<(data: unknown) => void>>;
  emitted: Array<{ event: string; data: unknown }>;
  messages: Array<{ message: unknown; options?: unknown }>;
  entries: Array<{ customType: string; data?: unknown }>;
  /** Invoke every handler for `hook` in registration order; returns the last defined result. */
  fire(hook: string, event?: unknown, ctx?: unknown): Promise<unknown>;
  /** Deliver to `pi.events.on` subscribers, as a peer extension would. */
  emitBus(event: string, data: unknown): void;
}

export function createFakeApi(): FakeApi;
export function fakeCtx(overrides?: Partial<FakeCtx>): FakeCtx;   // defaults: hasUI true, mode "tui"
```

---

## Task 1 — Create `pi-suite` and subtree-merge all eight repos

**Files:** creates the repo; no source edits.

**Interfaces:** Produces the directory layout every later task depends on: `shared/`, `consult/`, `git/`, `lens/`, `memory/`, `spawn/`, `todo/`, `browser/`.

> **The tree does not build at the end of this task.** Eight `package.json` files coexist and imports still reference `pi-shared`. That is expected; Task 2 resolves it. This is a deliberate task boundary — the history merge is a distinct operation worth reviewing on its own.

- [ ] **Step 1:** `git init` a new `~/dev/pi/pi-suite`, initial commit containing only `.gitignore` (`node_modules`, `.ruff_cache`) and the AGPL-3.0 `LICENSE` copied from `pi-shared`. Subtree merges need a non-empty history to graft onto.
- [ ] **Step 2:** For each repo, run `git subtree add --prefix=<dir> <local-repo-path> main`, mapping repo name → destination directory by dropping the `pi-` prefix: `pi-consult`→`consult`, `pi-git`→`git`, `pi-lens`→`lens`, `pi-memory`→`memory`, `pi-spawn`→`spawn`, `pi-todo`→`todo`, `pi-browser`→`browser`, and `pi-shared`→`shared`.
- [ ] **Step 3:** Verify history grafted, not squashed.

**Acceptance:**
- Eight directories exist with their full prior contents.
- `git log --follow -- lens/src/lsp/manager.ts` reaches the pre-migration commits (`30561bf` and earlier).
- Repeat the `--follow` check for one file from each of the eight subtrees.
- `git log --oneline | wc -l` substantially exceeds the eight initial commits — history is present, not collapsed.

- [ ] **Step 4:** Commit any merge bookkeeping. Do **not** create the GitHub remote yet; it is created in Task 9 after the suite is green.

---

## Task 2 — Collapse manifests, rewrite imports, single tsconfig

**Files:**
- Create: `package.json`, `tsconfig.json` (repo root)
- Delete: `consult/package.json`, `git/package.json`, `lens/package.json`, `memory/package.json`, `spawn/package.json`, `todo/package.json`, `browser/package.json`, `shared/package.json`, and all eight `tsconfig.json` files
- Modify: every file importing `"pi-shared"` (13 known sites across `todo`, `git`, `lens`, `memory`)

**Interfaces:** Consumes Task 1's layout. Produces a building, green tree — the baseline every later task must keep green.

- [ ] **Step 1:** Write the root `package.json`: `name: "pi-suite"`, `private: true`, `type: "module"`, `license: "AGPL-3.0"`, `keywords: ["pi-package"]`, the five peerDeps at `"*"`, devDeps `@types/bun` + `typescript` only (**no `pi-shared`**), scripts `check`/`test`, and:

```json
"pi": { "extensions": [
  "./memory/index.ts", "./todo/index.ts", "./git/index.ts", "./consult/index.ts",
  "./spawn/index.ts", "./browser/index.ts", "./lens/index.ts"
] }
```

Order is D6 and load-order-significant; add a comment in `README.md` (JSON cannot hold one) explaining that lens is last so its `tool_result` injection wraps outermost.

- [ ] **Step 2:** Write the root `tsconfig.json` — merge of the eight identical ones (strict, ESM, bundler resolution, `allowImportingTsExtensions`), with `include` covering all extension dirs plus `shared/`.
- [ ] **Step 3:** Delete the eight sub-manifests and sub-tsconfigs.
- [ ] **Step 4:** Rewrite every `from "pi-shared"` to the correct relative path — `../shared/index.ts` from `<ext>/src/`, `./shared/index.ts` from root-level files. Add `shared/index.ts` re-exports for anything currently imported that the barrel does not yet expose.
- [ ] **Step 5:** `bun install` at the root; confirm one `node_modules`.
- [ ] **Step 6:** Run `bunx tsc --noEmit`.
- [ ] **Step 7:** Run `bun test`.
- [ ] **Step 8:** Commit.

**Acceptance:**
- `tsc --noEmit` clean.
- All pre-existing tests pass, **bodies unmodified** — only import paths may differ.
- `grep -rn 'from "pi-shared"' .` (excluding `node_modules`) returns nothing.
- No `package.json` exists below the repo root.

---

## Task 3 — `shared/exec.ts`

**Files:**
- Create: `shared/exec.ts`, `shared/test/exec.test.ts`
- Delete: `lens/src/exec.ts`, `lens/test/exec.test.ts`, and the local `ExecFn`/`defaultExec` definitions inside `git/src/git.ts`, `browser/src/browser.ts`, `consult/src/consult.ts` (plus the `RunFn` alias in consult)
- Modify: importers in `lens/`, `git/`, `browser/`, `consult/`

**Interfaces:** Produces `ExecOptions`, `ExecFn`, `MAX_BUFFER`, `defaultExec` as specified above.

- [ ] **Step 1:** Write `shared/test/exec.test.ts` first. It must carry over every assertion from `lens/test/exec.test.ts` and cover: a successful command's stdout/exit-0; a missing binary resolving (not rejecting) with a non-zero code; a non-zero exit surfacing its code and stderr; `cwd` honored; `env` merged over `process.env`; an aborted `signal` settling rather than hanging.
- [ ] **Step 2:** Run it; confirm it fails (module absent).
- [ ] **Step 3:** Implement `shared/exec.ts`. Behavior is the union of the four current variants: `execFile`, resolve-never-reject, `error.code` numeric → that code, other error → 1, `maxBuffer` = `MAX_BUFFER`.
- [ ] **Step 4:** Point the four consumers at it and delete the local copies. `consult/src/consult.ts` keeps its injectable-runner seam — retype its parameter to `ExecFn` and adapt the call site, since its current `RunFn` takes a required (not optional) opts argument.
- [ ] **Step 5:** `bunx tsc --noEmit` and `bun test`.
- [ ] **Step 6:** Commit.

**Acceptance:**
- One `defaultExec` in the tree; `grep -rn "execFile(" --include=*.ts .` (excluding `node_modules`) hits only `shared/exec.ts`.
- pi-git's env-merge and pi-browser's stderr-fallback behaviors are both still covered.
- All prior tests green.

---

## Task 4 — `shared/config.ts`

**Files:**
- Create: `shared/config.ts`, `shared/test/config.test.ts`
- Delete: the seven `test/config.test.ts` files
- Modify: the seven `src/config.ts` files → thin `ConfigSpec` declarations retaining each `DEFAULTS` and `parse`

**Interfaces:** Produces `ConfigSpec<T>`, `agentDir`, `configPath`, `loadConfig`, `saveConfig`.

- [ ] **Step 1:** Write `shared/test/config.test.ts` as a parameterized suite over all seven specs. It must preserve every assertion class from the deleted suites: missing file → defaults; save/load round-trip; malformed JSON → defaults; missing fields backfilled from defaults; an invalid `mode` value → `DEFAULT_MODE`. Add two new cases for the D5 convergence: `configPath` honors `PI_CODING_AGENT_DIR` when set, and falls back to `~/.pi/agent` when not.
- [ ] **Step 2:** Run it; confirm it fails.
- [ ] **Step 3:** Implement `shared/config.ts`. `loadConfig` reads, `JSON.parse`es, and delegates field validation to `spec.parse`; **any** throw anywhere returns `{...spec.defaults}`. `saveConfig` does `mkdir -p` then writes pretty JSON with a trailing newline.
- [ ] **Step 4:** Reduce each `<ext>/src/config.ts` to its interface, `DEFAULTS`, a `parse`, an exported `ConfigSpec`, and thin `loadConfig`/`saveConfig` wrappers preserving today's call signatures so no call site changes. Preserve each extension's exact validation semantics — notably pi-git's nested `worktrees` object and pi-spawn's numeric `concurrency`.
- [ ] **Step 5:** `bunx tsc --noEmit` and `bun test`.
- [ ] **Step 6:** Commit.

**Acceptance:**
- All seven extensions resolve config through `shared/config.ts`.
- With `PI_CODING_AGENT_DIR` set, **all seven** read from it (was two).
- Distinct config assertions ≥ the pre-merge total.

---

## Task 5 — `shared/settings-panel.ts`

**Files:**
- Create: `shared/settings-panel.ts`
- Modify: the seven `<ext>/src/command.ts` files — delete the local `openSettingsPanel`, import the shared one

**Interfaces:** Produces `openSettingsPanel` as specified.

- [ ] **Step 1:** Diff the seven copies against each other and confirm they are identical modulo whitespace. **If any differs materially, stop and report** — divergence means the extraction is not behavior-preserving and needs a decision.
- [ ] **Step 2:** Move one copy verbatim into `shared/settings-panel.ts`. Add a comment above the `clip()` helper recording *why* it exists: a `ctx.ui.custom` render wider than the terminal crashes Pi with `Rendered line N exceeds terminal width`. Without the comment a later cleanup will delete it.
- [ ] **Step 3:** Delete the seven copies; import the shared one.
- [ ] **Step 4:** `bunx tsc --noEmit` and `bun test`.
- [ ] **Step 5:** Commit.

**Acceptance:**
- Exactly one `openSettingsPanel` definition in the tree.
- All seven `/pi-*` panels still open in the Task 9 dogfood (deferred verification — this task has no automated UI coverage, which is itself a reason the dogfood gate exists).

---

## Task 6 — Wiring harness and per-extension wiring tests

**Files:**
- Create: `shared/test/harness.ts`, `shared/test/tags.test.ts`, and `<ext>/test/wiring.test.ts` for all seven

**Interfaces:** Consumes each `<ext>/index.ts` default export. Produces `createFakeApi`, `fakeCtx`.

This is the highest-value task in the plan: the wiring layer has never had coverage in any repo, and three of the review's findings live there.

- [ ] **Step 1:** Implement `shared/test/harness.ts` to the interface above. `createFakeApi` records `registerTool`, `registerCommand`, `on`, `events.emit`, `events.on`, `sendMessage`, `appendEntry`. `fire(hook, event, ctx)` awaits handlers in registration order. `fakeCtx` defaults to `hasUI: true`, `mode: "tui"`.
- [ ] **Step 2:** Write `shared/test/tags.test.ts` — `tagName`, `injectionHeader`, and `injectionBlock` round-trip and wrap correctly. `pi-shared` shipped zero tests despite four exported runtime functions.
- [ ] **Step 3:** Write the seven wiring tests. Each loads its `index.ts`, invokes it with a fake API, and asserts registrations plus at least one hook behavior. Required coverage per extension:
  - **all seven** — registers exactly the tools in `SURFACE`, and exactly one command named `pi-<dir>`.
  - **todo** — subscribes `session_start`, `session_compact`, `agent_settled`; firing `agent_settled` with `hasUI: false` sends **no** message (the print-mode hang guard); with `hasUI: true` and a pending todo it does.
  - **lens** — subscribes `tool_result`, `agent_settled`, `session_start`, `session_shutdown`; `tool_result` for a non-file tool returns undefined; `mode: "off"` suppresses injection.
  - **git** — subscribes `message_start`, `session_before_fork`, `session_shutdown`; a `message_start` with `role: "user"` does **not** checkpoint; `mode: "off"` suppresses.
  - **memory** — subscribes `context` and bus-subscribes `verify:failed`; `mode: "off"` suppresses injection; `emitBus("verify:failed", …)` with `autoCapture: false` writes nothing.
  - **spawn** — registers `spawn`; depth guard refuses when `PI_SPAWN_DEPTH` ≥ 2.
  - **consult**, **browser** — register their tool and command; no hooks.
- [ ] **Step 4:** Run all; confirm green (these describe current behavior, so they should pass once written correctly — a failure here means either a harness bug or a genuine latent defect; investigate rather than adjusting the assertion to match).
- [ ] **Step 5:** Commit.

**Acceptance:**
- Every `<ext>/index.ts` is exercised by at least one test.
- The `!hasUI` guard is pinned for both todo and lens.
- No production source changed in this task.

---

## Task 7 — Contract and boundary tests

**Files:**
- Create: `shared/surface.ts`, `test/contract.test.ts`, `test/boundaries.test.ts`
- Modify: `shared/index.ts` (export `SURFACE`)

**Interfaces:** Consumes `SURFACE`, `EVENTS`, and the Task 6 harness. This is the drift guard that makes HOUSE-STYLE enforceable rather than aspirational.

- [ ] **Step 1:** Write `shared/surface.ts` declaring all seven entries — `git` has `tools: []`; `lens`, `browser`, `spawn`, `consult` have one tool each; `todo` has `todo_write`; `memory` has `memory_recall` and `memory_write`. Seven tools total.
- [ ] **Step 2:** Write `test/contract.test.ts` asserting:
  - Loading all seven extensions under the harness yields exactly the tool names in `SURFACE` — no extras, none missing.
  - Each extension registers exactly one command, matching `SURFACE[i].command`.
  - Every event-name string literal appearing in an `emit(...)` call across `*/src/**.ts` and `*/index.ts` exists in `EVENTS`. (Source scan; `EVENTS` is the vocabulary SSOT.)
  - `docs/HOUSE-STYLE.md` mentions every tool name in `SURFACE` — the doc is checked against code, never the reverse.
- [ ] **Step 3:** Write `test/boundaries.test.ts` enforcing D7: scan every `.ts` under the seven extension dirs, collect import specifiers, and allow only relative paths resolving inside the importing extension's own directory, paths resolving into `shared/`, `node:*`, and the five peer packages. Anything else fails, naming file and specifier.
- [ ] **Step 4:** Verify the boundary test actually bites — temporarily add a cross-extension import (e.g. `lens/src/tools.ts` importing from `git/src/git.ts`), confirm the test fails, then revert. A guard never seen failing is not a guard.
- [ ] **Step 5:** Run all; commit.

**Acceptance:**
- Contract test passes and fails loudly when a tool is renamed without updating `SURFACE`.
- Boundary test demonstrated failing on a deliberate violation, then green.

---

## Task 8 — Install smoke test and CI

**Files:**
- Create: `scripts/smoke-install.sh`, `.github/workflows/ci.yml`

**Interfaces:** Consumes the Task 6 harness. **This is the task that proves the P0 is fixed.**

- [ ] **Step 1:** Write `scripts/smoke-install.sh`: clone the repo at `HEAD` into a temp dir, run `npm install --omit=dev` there — *exactly what Pi does* — then execute a check that imports all seven `index.ts` entry points, invokes each with the fake API, and asserts seven extensions register their expected tools. Exit non-zero on any import or registration failure. Clean up the temp dir.

  Deliberately reuses `shared/test/harness.ts` rather than requiring a `pi` binary in CI: the failure being guarded is **module resolution with devDependencies absent**, which an import + registration check exercises directly.

- [ ] **Step 2:** Verify the smoke test *catches the original bug*: temporarily add `"pi-shared": "github:kazzarahw/pi-shared"` to devDependencies and change one import back to `from "pi-shared"`; confirm the script exits non-zero; revert. Same principle as Step 4 of Task 7.
- [ ] **Step 3:** Write `.github/workflows/ci.yml` — on push and PR, on `ubuntu-latest`: set up Bun, `bun install`, then `bunx tsc --noEmit`, `bun test`, and `scripts/smoke-install.sh`. Note in a comment that the smoke step needs Node/npm as well as Bun, since it invokes `npm install` directly.
- [ ] **Step 4:** Run the full sequence locally exactly as CI will.
- [ ] **Step 5:** Commit.

**Acceptance:**
- `scripts/smoke-install.sh` passes on the current tree.
- It was **observed failing** on a deliberately reintroduced devDependency import.
- CI runs typecheck, tests, and smoke on every push.

---

## Task 9 — Docs, live dogfood, and cutover

**Files:**
- Move: `shared/HOUSE-STYLE.md` → `docs/HOUSE-STYLE.md`; `shared/docs/superpowers/**` → `docs/superpowers/**`
- Modify: `docs/HOUSE-STYLE.md` (§2 and §10 only), root `README.md`
- Delete: `shared/README.md` (its content becomes the root README)

**Scope guard:** correct **only** the packaging claims that consolidation just falsified. §10's "types-only, `devDependency`, types erase at compile time" and §2's repo-skeleton/install lines are now describing something that no longer exists. The deeper contradictions — §9's throw rule, §7's settings claim, `block` semantics, the dead event vocabulary — are **sub-project 3** and must not be touched here.

- [ ] **Step 1:** Relocate the docs; update internal links.
- [ ] **Step 2:** Rewrite HOUSE-STYLE §10 to describe `shared/` as an internal module (no package, no dependency classification), and §2's skeleton/install lines to describe the single package and `pi install git:github.com/kazzarahw/pi-suite`. Add a one-line note that the surface map is now enforced by `test/contract.test.ts`.
- [ ] **Step 3:** Rewrite the root `README.md` from `pi-shared/README.md`: the roster table stays; replace the seven-install loop with the single command; document the D6 load order and its rationale; document `shared/`.
- [ ] **Step 4:** Cut the local install over: `pi remove` each of the seven local-path entries, then `pi install /home/kazzarah/dev/pi/pi-suite`. Leave the eight old working directories on disk.
- [ ] **Step 5:** **Live tmux dogfood** — `tmux new-session -d -s pi -x 200 -y 50` in a scratch polyglot repo, driving the real TUI. Confirm on screen, per the spec's acceptance bar:
  - all seven `/pi-*` settings panels open and toggle;
  - `todo_write` renders the widget; `consult` returns advice; `spawn` runs a scout; `browser` opens a page; `memory_write` then `memory_recall` round-trips and the INDEX appears in context;
  - pi-lens injects a `<pi-lens>` diagnostic on first read of a TS file;
  - pi-git checkpoints a turn and `/fork` reverts files on disk.

  **Not** "pi started" — each must be observed.
- [ ] **Step 6:** Commit. Create `github.com/kazzarahw/pi-suite` and push.
- [ ] **Step 7:** **Only after CI is green on the pushed repo**, archive the eight old repos on GitHub (Settings → Archive). Do not delete.

**Acceptance:**
- No doc claims `shared/` is a package or a dependency.
- `pi install git:github.com/kazzarahw/pi-suite` works on a clean machine.
- Every dogfood item above observed in a real TUI.
- Eight repos archived, not deleted; old working dirs intact.

---

## Self-Review

**Spec coverage:** D1 → Tasks 1–2. D2/D3/D4 (rejected alternatives) → no task needed. D5 → Tasks 3 (maxBuffer) and 4 (`PI_CODING_AGENT_DIR`). D6 → Task 2 Step 1. D7 → Task 7 Step 3, with the ESLint→test refinement flagged above. D8 → Tasks 3–4 (forced merges) and 6 (added layer). D9 → no task; it was a risk finding that justified D1. Verification section → Tasks 6, 7, 8; acceptance gate → Task 9. Rollback → Task 9 Steps 4 and 7 preserve every escape route.

**Placeholder scan:** no TBD/TODO; every step names exact paths and commands; no step defers detail to "handle edge cases."

**Type consistency:** `ExecFn`/`ExecOptions` (Task 3) are consumed unchanged in Task 4's `ConfigSpec` neighborhood and by the four extensions. `ConfigSpec<T>` (Task 4) is referenced by name in Tasks 4 and 7. `FakeApi`/`fakeCtx` (Task 6) are consumed by Tasks 7 and 8. `SURFACE`/`ExtensionSurface` (Task 7) is consumed by Task 7's contract test and referenced in Task 6's per-extension assertions — **note the ordering dependency: Task 6's "registers exactly the tools in `SURFACE`" assertion needs `shared/surface.ts`, which Task 7 Step 1 creates.** Resolution: Task 6 asserts tool names as literals; Task 7 Step 1 then replaces those literals with `SURFACE` references as part of introducing it. Called out so the Task 6 implementer does not reach for a module that does not exist yet.

**Known gap, accepted:** Task 5 has no automated coverage — `openSettingsPanel` renders TUI components that the fake harness does not simulate. It is verified only by the Task 9 dogfood. Building a TUI render harness is disproportionate here; the dogfood gate is the mitigation.
