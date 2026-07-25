# pi-suite Correctness Hardening — Design

**Date:** 2026-07-24
**Status:** approved, pending implementation plan
**Scope:** sub-project 2 of 4 (see *Program context*)

---

## Program context

Sub-project 1 (Consolidation) shipped: one repo, one package, seven extensions,
`shared/` internals, CI with contract/wiring/smoke guards. It deliberately fixed
packaging and structure only, deferring every behavioral defect to this document.

1. ~~**Consolidation**~~ — shipped 2026-07-24.
2. **Correctness hardening** *(this document)* — unbounded waits, `cwd`
   correctness, trust gating, output truncation, and four data-correctness bugs.
3. **Contract reconciliation + cooperation layer** — what `mode: "block"` means,
   which events earn subscribers, whether config moves to Pi's `settings.json`,
   restoring HOUSE-STYLE as an enforceable contract.
4. **Pi-integration polish** — `promptGuidelines`, `renderCall`/`renderResult`,
   `onUpdate` streaming, `resources_discover`.

This sub-project fixes behavior only. It changes no packaging, no event
vocabulary, and no agent-facing tool surface: `SURFACE` is untouched, so
`test/contract.test.ts` should pass unmodified throughout.

---

## Problem

Every defect below was located in the consolidated tree and verified against the
code, not carried over from the review's notes.

### P0 — user-visible breakage

**1. LSP requests never time out.** `lens/src/lsp/client.ts:120` resolves a request
only when a reply carrying a matching JSON-RPC id arrives. There is no timeout, no
reject path, and no abort handling. `hover` / `references` / `definition` /
`rename` / `shutdown` all await it. The manager bounds `ready()` (racing
`initialize` against `warm`) and `pull()` (a `setTimeout`), but `onDead`
(`manager.ts:66`) settles `warm` and deletes the entry **without settling the
`pending` map** — so a server that dies mid-query leaves that promise unsettled
forever, and the `pending` entry leaks.

The previous attempt at this fix (`30561bf`, the `which` check plus `onDead`)
landed at the *spawn* layer. It prevents spawning an absent binary; it does not
bound a request. The hang survives it.

**2. `_signal` is discarded.** `lens/src/tools.ts:38` receives the tool's
`AbortSignal` and ignores it, so Esc cannot cancel defect 1 either. The only
recovery is killing Pi.

**3. `writeMemory` deletes across scopes.** `memory/src/store.ts:60-62` documents
itself as "deduping by name across scopes" and calls `deleteMemory(m.name, cwd)`,
which loops over both the project and global directories (`:70-79`). Writing a
**project** memory named `foo` therefore silently destroys a **global** memory
named `foo`. Data loss, no warning.

**4. Untrusted code execution.** `lens/index.ts:95-106` runs
`cfg.verifyCmd || autodetectVerify(cwd)` through `sh -c` on `agent_settled`. The
autodetected command comes from the repository's own files. Opening a hostile
repository and letting the agent make one edit is sufficient to execute it. There
is no `ctx.isProjectTrusted()` call anywhere in the suite.

**5. The LSP project root is captured at load time.** `lens/index.ts:34` runs
`const cwd = process.cwd()` in the extension factory and passes it to
`createManager(cwd)` on the next line. That value becomes the child process `cwd`
and the `initialize` `rootUri`. When Pi's session cwd differs from the process
cwd, every diagnostic and every query is rooted in the wrong project — for the
whole session, unrecoverably.

### P1 — correctness and hygiene

- **`cwd` is resolved two different ways.** The correct idiom,
  `ctx?.sessionManager?.getCwd?.() ?? process.cwd()`, appears **four times,
  copy-pasted verbatim**: `git/index.ts:18`, `memory/index.ts:28`,
  `memory/src/tools.ts:14`, `spawn/src/tools.ts:57`. The five sites that break are
  exactly the ones the copy-paste missed: `lens/index.ts:34` (feeding `:35`, `:98`,
  `:103`, `:137`), `memory/index.ts:48`, `:59`, `:60`, and `spawn/index.ts:34`.
  The duplication *is* the bug's cause.
- **Linters run in the wrong directory.** `lens/src/linters.ts` receives `cwd`
  and uses it to gate `enabledFor` (`:22`), then calls `exec(cmd, args)` (`:29`)
  with no options at all — so the linter subprocess inherits the process cwd.
- **Verify drops the signal it is offered.** `runVerify` accepts a `signal`
  (`verify.ts:37-43`) and `lens/index.ts:103` calls it without one.
- **No output truncation anywhere.** Zero occurrences of any truncation helper
  across the suite. A large linter, verify, browser, or subagent output goes into
  context whole.
- **No subprocess timeout.** `shared/exec.ts` exposes no `timeout`, though
  `execFile` supports one. `spawn/src/runner.ts` handles abort (SIGTERM→SIGKILL,
  `:123-131`) but has no deadline, so a wedged subagent runs until the user
  notices.
- **`pi-memory` re-reads every memory file on every LLM call.**
  `memory/index.ts:29` calls `listMemories(cwd)` inside the `context` hook, which
  fires once per call and hits the disk for every file each time.
- **`git.restoreTree` is destructive with no undo.** It is `checkout-index -a -f`
  plus removal of extras (`git/src/git.ts:63-78`), and `restoreOnForkShutdown`
  (`hooks.ts:42`) calls it without snapshotting first. Once a fork restores, the
  discarded state is unrecoverable.
- **File state follows session position in only one direction.** `pi-git` hooks
  the fork path alone, so rewinding a message reverts files, but navigating the
  session tree forward or across branches leaves the working tree behind. The
  automatic tracking the extension exists to provide is half-wired.
- **Checkpoint refs are never collected.** `listRefs` (`git/src/git.ts:22,93`) has
  zero production callers — only tests. `refs/pi-git/checkpoints/` grows without
  bound for the life of the repository.

---

## Decisions

### D1 — Bound at the layer that owns the state

The request timeout goes **inside `request()` in `client.ts`**, not in the manager
and not in the tool. `request()` is the only scope holding both the `pending` map
and the request id, so it is the only place that can settle the promise *and*
remove the entry. Bounding it there covers all five callers at once, including
`shutdown()`, and fixes the `pending` leak as a side effect.

This is a direct correction of the earlier fix, which bounded process *spawning*
one layer too high and left the request itself unbounded. The general rule this
encodes: **bound the await where its state lives.**

Mechanically, each request gets one idempotent `settle` invoked by whichever of
three paths fires first — matching reply, deadline, or abort — which clears the
timer and deletes the map entry. `client.dispose(reason)` rejects everything
in flight and is wired to the manager's existing `onDead`, closing the
server-died-mid-query hole.

### D2 — A timeout rejects; it never resolves empty

`request()` currently maps a JSON-RPC error to `null` (`client.ts:105`), and the
result converters turn `null` into `[]` or `"(no hover info)"`. If a timeout took
that same path, `references` against a wedged server would report
`(none found)` — a confident, wrong answer the agent would then act on.

Timeouts and disposals therefore **reject** with a typed `LspUnavailableError`.
The three consumers each handle it distinctly:

- the `lens` tool lets it propagate (throwing is Pi's only way to set `isError`),
  so the agent is told the server did not respond;
- `manager.pull()` catches it and returns `[]`, because absent diagnostics are
  genuinely just absent;
- `manager.ready()`'s `initialize` race already has `.catch(() => {})`.

Distinguishing "slow" from "empty" is the entire point of the fix.

### D3 — One `cwdOf`, and bare `process.cwd()` becomes a CI failure

`shared/cwd.ts` gets the single implementation. Eight of the nine sites call it
directly; the ninth is the ctx-less bus callback handled by D12. Because
the root cause of the five broken sites was duplication rather than ignorance,
deduplication alone does not prevent recurrence — so `test/boundaries.test.ts`
gains a source scan asserting that `process.cwd()` appears nowhere outside
`shared/cwd.ts` and test files. This converts the whole bug class into a CI
failure, the same technique sub-project 1 used against documentation drift.

Three of the broken sites (`memory/index.ts:59`, `:60`, `spawn/index.ts:34`) are
inside command dependency closures that currently take no arguments. Verified:
`ExtensionCommandContext extends ExtensionContext`
(`pi-coding-agent` `types.d.ts:248`), so a command handler has both
`sessionManager` (`:218`) and `isProjectTrusted()` (`:228`). The fix is therefore
to widen those deps to take a `cwd` parameter and resolve it from the handler's
context at invoke time — no new plumbing, and it removes the last excuse for a
module-scope cwd.

### D4 — LSP clients are keyed by `(cwd, command)`; no load-time capture

`createManager()` loses its `cwd` construction parameter. `ready()` and `pull()`
take `cwd` per call from the hook's context, and the client map is keyed by
`` `${cwd}\0${cmdKey}` ``. A session whose cwd changes gets a correctly-rooted
second server rather than a silently wrong first one, and `shutdownAll()` still
tears everything down because it iterates the same map.

Rejected: passing a `() => cwd` thunk into the manager. It hides the dependency
inside a closure and keeps the tests unable to vary cwd per call; an explicit
parameter is both more honest and more testable.

### D5 — Trust gates autodetected commands only

On `agent_settled`, when `ctx.isProjectTrusted()` is false:

- an **autodetected** verify command is skipped — it originates in repository
  content, which is exactly the untrusted input;
- an **explicitly configured** `cfg.verifyCmd` still runs — the user typed it, and
  it is their decision to make.

Diagnostics, linters, and formatting are unaffected; they act on a named file
rather than executing repository-authored command strings. When a verify is
skipped for trust, lens says so once per session instead of failing silently — an
invisible safety gate reads as a broken feature.

This matches Pi's documented intent for the API: *"Use this before reading
project-local extension configuration that should only be honored for trusted
projects."*

### D6 — Use Pi's truncation utilities; render them once

`truncateHead`, `truncateTail`, `truncateLine`, `formatSize`, `DEFAULT_MAX_BYTES`
(51200) and `DEFAULT_MAX_LINES` (2000) are **publicly exported from
`@earendil-works/pi-coding-agent`**, already a peerDependency at `"*"`. Verified
by live import; behavior confirmed
(`truncateHead("a\nb\nc\nd\n", {maxLines: 2})` → `{content: "a\nb",
truncated: true, truncatedBy: "lines"}`).

Note for future work: they are *not* reachable from `@earendil-works/pi-agent-core`.
That package's `exports` map exposes only `.`, `./node` and `./package.json`, so
the deep path `…/harness/utils/truncate` fails to resolve. The review's original
claim that Pi "exports truncateHead/truncateTail" is true only of
`pi-coding-agent`.

Pi's functions return a `TruncationResult` struct, not a string. `shared/truncate.ts`
wraps them so the suite renders one consistent agent-facing marker naming what was
dropped, rather than seven ad-hoc formats. Reimplementing the truncation itself is
rejected: matching Pi's line/byte semantics by hand is pointless duplication of a
dependency already present at runtime.

### D7 — `exec` gains a timeout, with a backstop, and must not hide it

`ExecOptions` gains `timeout?: number`. `defaultExec` applies
`DEFAULT_EXEC_TIMEOUT_MS` when the caller specifies none, so a forgotten call site
degrades to "bounded generously" rather than "unbounded".

The existing contract — *always resolves, never rejects* — is preserved. Verified
`execFile` timeout behavior: `code: null`, `killed: true`, `signal: "SIGTERM"`,
partial output still present on stderr. `code: null` is not a number, so the
existing mapper falls through to `1`; non-zero, as required.

One additional change is required. Line 53 currently prefers non-empty `stderr`
over `error.message`, so a command killed at its deadline returns only its partial
output and the caller cannot tell a timeout from an ordinary failure. When
`killed` is true, the result must state that the deadline was hit. This is the
same class of error as D2: never report a bounded wait as a normal empty result.

### D8 — `writeMemory` dedups within the target scope only

`deleteMemory` gains an optional `scope`. `writeMemory` passes `m.scope`, so a
project write can no longer destroy a global memory. An explicit user deletion via
`/pi-memory` keeps the both-scopes behavior, which is what "delete this memory"
should mean when the user names it.

This lands in wave 1 rather than with the other data-correctness work: it is a
two-line fix for silent data loss and should not wait behind a refactor.

### D9 — The memory index is cached per cwd, validated by directory mtime

`listMemories(cwd)` caches its result and revalidates with a `stat` of the memory
directories instead of reading every file. Writes and deletes through `store.ts`
invalidate explicitly; the mtime check covers edits made by another process or by
hand, which an in-process invalidation alone would miss.

Injection stays at `messages[0]` (per the approved answer). The prompt cache is
still invalidated when a memory actually changes, which is correct and rare — the
defect was re-reading the disk on every call, not the placement.

### D10 — Git follows the session tree in both directions; no manual command

The defect is that a restore discards the current working tree unrecoverably. The
fix is **not** an undo command. `pi-git` exists to make file state follow session
position automatically — the same model as other harnesses, where the harness's
own navigation *is* the undo/redo interface and files simply move with you. A
`/pi-git undo` would be an admission that the automatic behavior is incomplete.

Two changes:

**Snapshot before restoring.** Every restore first checkpoints the current working
tree against the entry being left. Since checkpoints are keyed by entry id in a ref
namespace, the abandoned state becomes an ordinary checkpoint, reachable by
navigating back to it. This dissolves "destructive with no undo" without inventing
an undo concept, a second ref namespace, or a command.

**Hook tree navigation.** `pi-git` currently hooks only the fork path
(`session_before_fork` + `session_shutdown`), so rewinding a message reverts files
but navigating forward or across branches does not. Pi fires
`session_before_tree` (before, cancellable) and `session_tree` (after) on `/tree`
navigation. Checkpointing on the former and restoring on the latter makes forward
navigation behave exactly like backward navigation — redo, for free, by symmetry.

Taking the checkpoint in `session_before_tree` rather than deriving it from
`session_tree`'s `oldLeafId` is deliberate. Checkpoints are keyed by *user-message*
entry ids, while the event carries *leaf* ids, which may be assistant entries. Both
hooks can therefore reuse `currentUserEntryId(sm)` unchanged — it reads the branch,
which is correct before navigation and correct again after it — and no leaf-to-turn
resolution is needed on either side.

**GC by age, not by count.** A "newest N" cap is unsafe once navigation can reach
arbitrarily far back: pruning a checkpoint that is still reachable in the session
tree would silently break its restore. Checkpoints are instead pruned when older
than `checkpointTtlDays` (default 30), which bounds growth across sessions while
leaving everything reachable in a live session intact. This gives `listRefs` its
first production caller; `Git` gains `deleteRef`.

### D11 — Slash commands are configuration surface, not action surface

Every `/pi-<name>` command opens that extension's settings (optionally taking a
mode argument). Adding verbs to them would make the same capability reachable two
ways, and for `pi-git` specifically an action verb would paper over automatic
behavior that should simply work. Where a capability is meant to be automatic, the
fix goes in a hook; where it is meant to be agent-driven, it goes in a tool.

`test/contract.test.ts` already pins one command per extension. HOUSE-STYLE should
record the *reason*, which is sub-project 3's job.

### D12 — Memory's bus callback caches the session cwd locally

`memory/index.ts:48` sits inside `pi.events.on("verify:failed", …)`. Bus callbacks
receive only `data` — there is no context to resolve a cwd from, so `cwdOf` cannot
fix this site the way it fixes the other eight.

The extension therefore records the session cwd when its `context` hook runs and
uses that value in the bus callback, skipping the write if no cwd has been seen
yet. The alternative — putting `cwd` in the event payload — is the better long-term
design but changes the event vocabulary, which is sub-project 3's subject. Noted
there rather than pre-empted here.

### D13 — Testing: injected deadlines, not real waiting

Every new bound is tested through an injected timeout of a few milliseconds
against a fake that never replies, using a `within()` hang-detector. No test may
depend on a production default elapsing.

`within()` is currently defined twice — `lens/test/manager.test.ts:9` and
`shared/test/exec.test.ts:5` — which is the same duplication-breeds-drift pattern
this sub-project exists to fix. Since several more hang tests are about to use it,
it moves to `shared/test/harness.ts` and both copies are removed.

Three additions:

- **Hang regressions** — one per bounded path (LSP request, dispose-while-pending,
  abort-while-pending, exec deadline, spawn job deadline). Each fails by timing
  out the test, which is the only honest way to test a hang.
- **A cwd guard** — the source scan from D3.
- **A trust test** — untrusted plus autodetected command must not exec; untrusted
  plus configured command must.

Existing tests are preserved. Where a signature changes (`ready`, `pull`,
`createManager`, `deleteMemory`), call sites are updated rather than the tests
rewritten — they encode behavior worth keeping.

---

## Interfaces

### `shared/cwd.ts` (new)

```ts
export interface CwdSource {
  sessionManager?: { getCwd?: () => string };
}

/** The suite's single cwd resolution: session cwd when available, else process cwd. */
export function cwdOf(ctx?: CwdSource): string;
```

### `shared/truncate.ts` (new)

```ts
export interface TruncateOptions {
  maxLines?: number;   // default DEFAULT_MAX_LINES (2000)
  maxBytes?: number;   // default DEFAULT_MAX_BYTES (51200)
  keep?: "head" | "tail";  // default "head"
  label?: string;      // what was truncated, for the marker
}

/**
 * Truncate agent-facing output via Pi's own utilities, appending a marker naming
 * what was dropped when truncation occurred. Returns the text unchanged otherwise.
 */
export function truncateForAgent(text: string, opts?: TruncateOptions): string;
```

### `shared/exec.ts` (modified)

```ts
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;   // NEW — ms; defaults to DEFAULT_EXEC_TIMEOUT_MS
}

/** Backstop deadline for any command that does not specify one. */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;
```

`ExecResult` is unchanged. A timeout yields a non-zero `code` and a `stderr` that
states the deadline was exceeded (D7).

### `shared/deadline.ts` (new)

```ts
/** Combine a caller's abort signal with a deadline. Either one aborts the result. */
export function deadline(ms: number, parent?: AbortSignal): AbortSignal;
```

Built on `AbortSignal.any([...])` and `AbortSignal.timeout(ms)`, both verified
available in the target runtime. Used by the lens tool (Esc + request deadline)
and the spawn runner (Esc + job deadline).

### `lens/src/lsp/client.ts` (modified)

```ts
export class LspUnavailableError extends Error {
  readonly reason: "timeout" | "disposed";
  readonly method: string;
}

export interface LspClient {
  initialize(rootUri: string, signal?: AbortSignal): Promise<void>;
  didOpen(uri: string, text: string, languageId: string): void;
  didChange(uri: string, text: string): void;
  onDiagnostics(cb: (uri: string, ds: Diagnostic[]) => void): void;
  hover(uri: string, pos: Position, signal?: AbortSignal): Promise<string | null>;
  rename(uri: string, pos: Position, newName: string, signal?: AbortSignal): Promise<RenameEdit[]>;
  references(uri: string, pos: Position, signal?: AbortSignal): Promise<Location[]>;
  definition(uri: string, pos: Position, signal?: AbortSignal): Promise<Location[]>;
  shutdown(): Promise<void>;
  /** Reject every in-flight request. Called when the server process dies. */
  dispose(reason: string): void;
}

export interface LspClientOptions {
  requestTimeoutMs?: number;   // default REQUEST_TIMEOUT_MS
}

export const REQUEST_TIMEOUT_MS = 10_000;

export function createLspClient(io: LspIO, opts?: LspClientOptions): LspClient;
```

### `lens/src/lsp/manager.ts` (modified)

```ts
export interface LspManager {
  ready(path: string, cwd: string, signal?: AbortSignal): Promise<LspClient | null>;
  pull(path: string, cwd: string, timeoutMs?: number): Promise<Diagnostic[]>;
  diagnosticsFor(path: string): Diagnostic[];
  shutdownAll(): Promise<void>;
}

export function createManager(
  servers?: Record<string, ServerSpec>,
  which?: (bin: string) => boolean,
): LspManager;
```

`cwd` moves from construction to per-call (D4). Clients are keyed by
`` `${cwd}\0${cmdKey}` ``. `onDead` calls `client.dispose("server exited")`.

### `lens/src/linters.ts` (modified)

`runLinters` keeps its signature and forwards `{ cwd, timeout: LINTER_TIMEOUT_MS }`
to `exec`. `export const LINTER_TIMEOUT_MS = 30_000;`

### `lens/src/config.ts` (modified)

```ts
verifyTimeoutMs: number;   // default 600_000 — test suites vary widely
```

### `memory/src/store.ts` (modified)

```ts
/** Delete a memory. Omitting `scope` deletes from both scopes (explicit user delete). */
export function deleteMemory(name: string, cwd: string, scope?: Scope): void;

/** Write a memory, deduping **within the target scope only**. */
export function writeMemory(m: Memory, cwd: string): void;

/** Cached; revalidated by memory-directory mtime. */
export function listMemories(cwd: string): Memory[];

/** Drop the cache for one cwd, or all when omitted. */
export function invalidateIndexCache(cwd?: string): void;
```

### `git/src/git.ts` and `git/src/checkpoints.ts` (modified)

```ts
// git.ts — Git interface gains:
deleteRef(ref: string): Promise<void>;

// checkpoints.ts

/** Prune checkpoint refs older than `ttlDays`. Returns how many were removed. */
export function pruneCheckpoints(git: Git, ttlDays: number, nowMs: number): Promise<number>;
```

`nowMs` is injected rather than read from the clock so the TTL is testable without
waiting or stubbing globals.

### `git/index.ts` (modified)

Two hooks are added, mirroring the existing fork pair:

```ts
// Before navigating: preserve the tree we are leaving, so no state is discarded.
pi.on("session_before_tree", …)   // checkpoint at currentUserEntryId(sm)

// After navigating: make the working tree match the position we arrived at.
pi.on("session_tree", …)          // restore findCheckpoint(currentUserEntryId(sm))
```

Both reuse `currentUserEntryId` unchanged (D10). A position with no checkpoint —
an entry that never started a turn — is a no-op, matching today's fork behavior.
`/pi-git` gains no new arguments; `CommandDeps` is unchanged.

### `shared/test/harness.ts` (modified)

```ts
/** Reject if `p` has not settled within `ms` — the hang detector for bounded paths. */
export function within<T>(ms: number, p: Promise<T>): Promise<T>;
```

### `git/src/config.ts` and `spawn/src/config.ts` (modified)

```ts
// git
checkpointTtlDays: number;   // default 30 — age-based; a count cap is unsafe (D10)

// spawn
jobTimeoutMs: number;      // default 900_000 (15 min)
```

---

## Build sequence

**Wave 1 — primitives.** `shared/cwd.ts`, `shared/deadline.ts`,
`shared/truncate.ts`, the `exec` timeout (D7), and the `writeMemory` scope fix
(D8). Each lands with its own tests and is independently useful. Nothing else
changes yet, so the suite stays green throughout.

**Wave 2 — apply.** The LSP bound and `dispose` (D1, D2); signal threading through
the lens tool; the manager's cwd re-keying (D4); the trust gate (D5); linter
cwd + timeout; the remaining eight `cwdOf` sites plus the memory cwd cache (D12);
the spawn job deadline; truncation at the agent-facing boundaries (lens
diagnostics and verify output, consult advice, browser content, spawn output,
memory recall bodies); and the D3 CI guard, added last so it lands green.

**Wave 3 — repair.** The memory index cache (D9), git's snapshot-before-restore
plus the two tree-navigation hooks, and age-based checkpoint GC (D10).

Checkpoints between waves. Wave 1 and wave 3 are independent of each other; wave 2
depends on wave 1.

---

## Verification & acceptance

Behavioral, each one a test:

1. A fake LSP server that never replies: `lens` returns an error within the
   injected deadline instead of hanging, and the `pending` map is empty afterward.
2. Killing the server process mid-request rejects the in-flight promise via
   `dispose` rather than leaving it unsettled.
3. Aborting the tool's signal mid-request rejects promptly.
4. `pull()` against a dead or silent server resolves `[]` and does not throw.
5. A timed-out `exec` resolves with a non-zero code and a stderr that identifies
   the deadline — not merely the partial output.
6. An untrusted project skips an autodetected verify command and still runs an
   explicitly configured one.
7. Writing a project memory named `x` leaves a global memory named `x` intact.
8. `listMemories` performs no file reads on a second call when the directory is
   unchanged, and does re-read after a write.
9. A restore checkpoints the tree it is leaving, so navigating back returns to it —
   nothing is discarded unrecoverably.
10. Navigating the session tree forward restores that position's tree, not just
    backward: undo and redo are symmetric.
11. Checkpoints older than `checkpointTtlDays` are pruned; newer ones survive.
12. The LSP root, linters, verify, and spawn all act on the session cwd when it
    differs from the process cwd.

Structural:

13. No bare `process.cwd()` outside `shared/cwd.ts` and test files (D3).
14. All 247 pre-existing tests still pass; `SURFACE` and `test/contract.test.ts`
    are unmodified.
15. `bunx tsc --noEmit` clean; `./scripts/smoke-install.sh` passes.
16. Each extension still registers exactly one command, and it opens settings (D11).
17. A live tmux dogfood covering the trust gate, an LSP timeout, and a `/tree`
    navigation in both directions with file changes following it.

---

## Out of scope

- **`mode: "block"` semantics**, event subscribers, and the `settings.json`
  migration — sub-project 3. Including the `cwd` event payload from D12.
- **HOUSE-STYLE §7 and §9 corrections** — sub-project 3, where the contract is
  reconciled as a whole rather than patched twice.
- **Spawn isolation** (worktrees, sandboxing) — a missing feature, not a defect,
  and a design question of its own.
- **`pi-git`'s dead worktree code** — removal or completion belongs with the
  contract work that advertises it.
- **Retry or reconnect for a dead LSP server.** This sub-project makes failure
  fast, bounded, and honest; automatic recovery is a feature.

---

## Rollback

Each wave is a series of small commits on `main` with CI green at every step, so
any individual fix reverts independently. The two changes with a persistent
footprint are the git undo ref and checkpoint GC; both live under
`refs/pi-git/`, are invisible to normal git operation, and are removable with
`git update-ref -d`. No user data format changes: memory files, config files, and
checkpoint refs all keep their existing on-disk shape.
