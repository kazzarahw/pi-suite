# pi-suite Correctness Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every behavioral defect catalogued in the sub-project 2 spec: unbounded waits, wrong-directory execution, missing trust gating, absent output truncation, and pi-git's storage model.

**Architecture:** Three primitives land in `shared/` first (`cwdOf`, `deadline`, `truncateForAgent`, plus `exec` gaining timeout/killed/env-unset), then get applied across the seven extensions, then pi-git's checkpoint storage is rebuilt from git trees to per-file content-addressed manifests. The suite stays green at every commit.

**Tech Stack:** TypeScript (strict ESM, `allowImportingTsExtensions`, `verbatimModuleSyntax`), Bun test, Pi extension API (`@earendil-works/pi-coding-agent` at peer `"*"`).

**Spec:** `docs/superpowers/specs/2026-07-24-pi-suite-correctness-hardening-design.md` — decisions are cited as D1–D15 throughout.

## Global Constraints

- **Plan-doc format:** interfaces and behavior, not pre-written bodies. Signatures below are contracts and must be matched exactly; test *cases* are listed as bullets and the implementer writes the bodies.
- **TDD:** every task writes its failing test first, watches it fail for the stated reason, then implements.
- **`SURFACE` is frozen.** No tool or command is added, removed, or renamed. `test/contract.test.ts` must pass unmodified through every task.
- **No test may wait on a production default.** Deadlines under test are injected in milliseconds (D15).
- **`shared/` stays a leaf** — it never imports from an extension, and extensions never import from each other (`test/boundaries.test.ts`).
- **`defaultExec` always resolves, never rejects.** A missing binary, non-zero exit, abort, or deadline all return a non-zero `code`.
- **Guard injection and turn-triggering on `ctx.hasUI`** — injecting with no interactive UI makes `pi -p` hang forever.
- **Commit per task**, message in the repo's existing style: imperative subject, body explaining *why*.
- **Verification gate for every task:** `bun test` green and `bunx tsc --noEmit` clean before commit.

---

## File Structure

**New in `shared/`**

| File | Responsibility |
|---|---|
| `shared/cwd.ts` | the single session-cwd resolution (D3) |
| `shared/deadline.ts` | combine a caller's abort signal with a deadline (D1, D15) |
| `shared/truncate.ts` | one agent-facing rendering over Pi's truncation utilities (D6) |

**New in `git/`**

| File | Responsibility |
|---|---|
| `git/src/store.ts` | the checkpoint store: manifests, blobs, restore, GC (D10) |
| `git/src/detect.ts` | `isRepo` + dirty-path enumeration; the only git left (D13, D14) |

**Deleted**

`git/src/git.ts` and `git/src/checkpoints.ts` lose `snapshotTree`, `restoreTree`, `updateRef`, `readRef`, `listRefs`, `checkpointRef`, `findCheckpoint`, `restoreTo`, `withTempIndex` and their tests (Task 16). `currentUserEntryId` survives unchanged. The worktree functions were already dead code and stay out of scope.

**Modified** — `shared/exec.ts`, `shared/test/harness.ts`, `lens/src/lsp/{client,manager}.ts`, `lens/src/{tools,linters,config}.ts`, `lens/index.ts`, `memory/src/store.ts`, `memory/index.ts`, `spawn/src/{runner,config}.ts`, `spawn/index.ts`, `git/{index.ts,src/config.ts}`, `consult/`, `browser/`, `test/boundaries.test.ts`.

---

# Wave 1 — Primitives

*Nothing else changes in this wave; the suite stays green throughout.*

### Task 1: `cwdOf` and a shared `within`

**Files:**
- Create: `shared/cwd.ts`, `shared/test/cwd.test.ts`
- Modify: `shared/test/harness.ts`, `shared/index.ts`
- Modify (remove local copies): `lens/test/manager.test.ts:9`, `shared/test/exec.test.ts:5`

**Interfaces — Produces:**
```ts
// shared/cwd.ts
export interface CwdSource { sessionManager?: { getCwd?: () => string } }
export function cwdOf(ctx?: CwdSource): string;

// shared/test/harness.ts
export function within<T>(ms: number, p: Promise<T>): Promise<T>;
```

- [ ] **Step 1 — Failing tests for `cwdOf`.** Cases: returns `getCwd()` when present; falls back to `process.cwd()` when `ctx` is `undefined`, when `sessionManager` is absent, and when `getCwd` is absent. The optional-chaining depth matters — all four shapes occur in the live call sites.
- [ ] **Step 2 — Run, confirm failure** (`bun test shared/test/cwd.test.ts`) — module not found.
- [ ] **Step 3 — Implement** `shared/cwd.ts`; export from `shared/index.ts`.
- [ ] **Step 4 — Move `within`** into `shared/test/harness.ts` and delete both local definitions, updating their imports. It is about to have five more callers; two copies is the duplication this sub-project exists to remove.
- [ ] **Step 5 — Verify** `bun test` (247 still pass) and `bunx tsc --noEmit`.
- [ ] **Step 6 — Commit.** *"Add shared cwdOf; hoist the within() hang detector"*

---

### Task 2: `exec` gains a deadline, `killed`, and env-unset

**Files:**
- Modify: `shared/exec.ts`
- Modify: `shared/test/exec.test.ts`

**Interfaces — Produces:**
```ts
export interface ExecOptions {
  cwd?: string;
  /** Merged over process.env. An `undefined` value REMOVES the variable (D13). */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeout?: number;              // ms; defaults to DEFAULT_EXEC_TIMEOUT_MS
}
export interface ExecResult {
  stdout: string; stderr: string; code: number;
  killed: boolean;               // true iff killed at its deadline (D7)
}
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;
```

**Behavior:**
- `timeout` passes through to `execFile`. Verified shape on deadline: `code: null`, `killed: true`, `signal: "SIGTERM"`, partial output still on stderr — so the existing mapper's fallthrough already yields a non-zero `code`.
- `killed` is derived from the error's `killed` flag, **not** from stderr content.
- `env` entries whose value is `undefined` are deleted from the merged environment rather than merged in as the string `"undefined"`.
- The always-resolves contract is preserved on every path.

- [ ] **Step 1 — Failing tests.** Cases: a command exceeding its timeout resolves with `killed === true` and non-zero `code`, wrapped in `within(...)` so a regression fails fast rather than hanging the suite; a command that writes to stderr *then* exceeds its timeout still reports `killed === true` (this is the case the old stderr-annotation approach got wrong); a normal failure has `killed === false`; `env: { FOO: undefined }` removes `FOO` from the child while `env: { FOO: "x" }` sets it; omitting `timeout` still completes a fast command.
- [ ] **Step 2 — Run, confirm failure** — `killed` is not a property of `ExecResult`.
- [ ] **Step 3 — Implement.** Widen `ExecOptions`/`ExecResult`, build the environment with an explicit delete pass, apply the backstop when `timeout` is undefined.
- [ ] **Step 4 — Verify.** All existing `exec` callers still typecheck; `ExecResult` gained a field, so no call site breaks.
- [ ] **Step 5 — Commit.** *"exec: add deadline, killed flag, and env-unset support"*

---

### Task 3: `deadline` and `truncateForAgent`

**Files:**
- Create: `shared/deadline.ts`, `shared/truncate.ts`, `shared/test/deadline.test.ts`, `shared/test/truncate.test.ts`
- Modify: `shared/index.ts`

**Interfaces — Produces:**
```ts
// shared/deadline.ts
export function deadline(ms: number, parent?: AbortSignal): AbortSignal;

// shared/truncate.ts
export interface TruncateOptions {
  maxLines?: number;   // default DEFAULT_MAX_LINES (2000)
  maxBytes?: number;   // default DEFAULT_MAX_BYTES (51200)
  keep?: "head" | "tail";   // default "head"
  label?: string;      // named in the marker, e.g. "diagnostics"
}
export function truncateForAgent(text: string, opts?: TruncateOptions): string;
```

**Behavior:**
- `deadline` is `AbortSignal.any([parent, AbortSignal.timeout(ms)])`, degrading to `AbortSignal.timeout(ms)` when `parent` is undefined. Both APIs verified available in the target runtime; the timeout path surfaces reason `TimeoutError`.
- `truncateForAgent` delegates to `truncateHead`/`truncateTail` from `@earendil-works/pi-coding-agent` (public exports, already a peer dependency — **not** reachable from `pi-agent-core`, whose exports map blocks the deep path). When `truncated` is false it returns the input unchanged; when true it appends one marker line naming what was dropped, using `formatSize` for byte counts.

- [ ] **Step 1 — Failing tests.** `deadline`: aborts when the parent aborts; aborts when the timer fires; does not abort before either. `truncateForAgent`: short input returned byte-identical with no marker; input over `maxLines` is cut and carries a marker naming line counts; `keep: "tail"` retains the end (the case that matters for verify output, where the failure is last); the marker includes the `label` when given.
- [ ] **Step 2 — Run, confirm failure** — modules not found.
- [ ] **Step 3 — Implement** both; export from `shared/index.ts`.
- [ ] **Step 4 — Verify** `bun test`, `bunx tsc --noEmit`.
- [ ] **Step 5 — Commit.** *"Add deadline() and truncateForAgent() primitives"*

---

### Task 4: `writeMemory` stops deleting across scopes (D8, P0 #3)

**Files:**
- Modify: `memory/src/store.ts:60-79`
- Modify: `memory/test/store.test.ts`

**Interfaces — Produces:**
```ts
export function deleteMemory(name: string, cwd: string, scope?: Scope): void;
export function writeMemory(m: Memory, cwd: string): void;   // now scope-limited
```

**Behavior:** `deleteMemory` with `scope` omitted keeps today's both-scopes behavior — that is what an explicit user deletion should mean. `writeMemory` passes `m.scope`, so a project write can no longer destroy a same-named global memory. The stale "deduping by name across scopes" comment is corrected.

- [ ] **Step 1 — Failing test.** Write a global memory `x`, then a project memory `x`; assert **both** survive with their own bodies. Add: `deleteMemory("x", cwd)` with no scope removes both; with `scope: "project"` removes only the project one.
- [ ] **Step 2 — Run, confirm failure** — the global `x` is currently destroyed by the project write.
- [ ] **Step 3 — Implement** the optional `scope` parameter and the `writeMemory` call site.
- [ ] **Step 4 — Verify.** Check `rewriteIndex` is still called for the scope actually touched, so `INDEX.md` does not drift.
- [ ] **Step 5 — Commit.** *"memory: dedup within the target scope only (fixes silent cross-scope data loss)"*

---

# Wave 2 — Apply

*Depends on wave 1.*

### Task 5: Bound the LSP request (D1, D2 — P0 #1)

**Files:**
- Modify: `lens/src/lsp/client.ts`
- Modify: `lens/test/client.test.ts`

**Interfaces — Produces:**
```ts
export class LspUnavailableError extends Error {
  readonly reason: "timeout" | "disposed";
  readonly method: string;
}
export const REQUEST_TIMEOUT_MS = 10_000;
export interface LspClientOptions { requestTimeoutMs?: number }
export function createLspClient(io: LspIO, opts?: LspClientOptions): LspClient;

// LspClient gains a signal on each query, plus:
dispose(reason: string): void;
```
Query methods become `hover(uri, pos, signal?)`, `references(uri, pos, signal?)`, `definition(uri, pos, signal?)`, `rename(uri, pos, newName, signal?)`, `initialize(rootUri, signal?)`.

**Behavior (this is the P0 — the previous fix landed one layer too high):**
- `request()` owns the `pending` map, so the bound goes **there**. Each request gets one idempotent `settle`, invoked by whichever of three paths fires first — matching reply, deadline, abort — which clears the timer and deletes the map entry.
- A timeout or dispose **rejects** with `LspUnavailableError`. It must not resolve `null`: `null` flows through `toLocations` into `[]` and would make `references` on a wedged server report `(none found)` — a confident wrong answer.
- A JSON-RPC *error* reply keeps resolving `null`, unchanged. Only bounded waits reject.
- `dispose(reason)` rejects every in-flight entry and empties the map.

- [ ] **Step 1 — Failing tests**, all wrapped in `within(...)` so a regression fails the test rather than hanging the run. Cases: a fake `io` that never replies rejects with `LspUnavailableError { reason: "timeout" }` at an injected 20 ms deadline, and `pending` is empty afterward; `dispose()` during an in-flight request rejects it with `reason: "disposed"`; aborting a passed signal rejects promptly; a normal reply still resolves and clears its timer; a JSON-RPC error reply still resolves `null` rather than rejecting.
- [ ] **Step 2 — Run, confirm failure** — the never-replies test times out at `within`'s bound, which *is* the bug.
- [ ] **Step 3 — Implement** `settle`, the timer, the abort listener, `dispose`, and thread `signal` through the five public methods.
- [ ] **Step 4 — Verify** no timer keeps the process alive: the suite must exit on its own, not hang after the last test.
- [ ] **Step 5 — Commit.** *"lens: bound every LSP request at the layer that owns pending"*

---

### Task 6: Manager keys clients by `(cwd, command)` and disposes dead ones (D4)

**Files:**
- Modify: `lens/src/lsp/manager.ts`
- Modify: `lens/test/manager.test.ts`

**Interfaces — Produces:**
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

**Behavior:**
- `cwd` moves from construction to per-call; the client map is keyed `` `${cwd}\0${cmdKey}` ``. A session whose cwd changes gets a correctly-rooted second server instead of a silently wrong first one.
- `onDead` now also calls `client.dispose("server exited")`, closing the hole where a server dying mid-query left `pending` unsettled.
- `pull()` catches `LspUnavailableError` and returns `[]` — absent diagnostics are genuinely absent (D2).

- [ ] **Step 1 — Failing tests.** Cases: two `ready()` calls with different `cwd` spawn two servers; same `cwd` twice reuses one; killing the process mid-`pull` resolves `[]` within `within(...)` rather than hanging; `shutdownAll` tears down every entry across both cwds.
- [ ] **Step 2 — Run, confirm failure** — `createManager` still takes `cwd`.
- [ ] **Step 3 — Implement** the signature change, composite key, and `dispose` wiring.
- [ ] **Step 4 — Update callers** so the package typechecks: `lens/index.ts` and `lens/src/tools.ts` (fully rewired in Tasks 7–8).
- [ ] **Step 5 — Commit.** *"lens: key LSP clients by (cwd, command); dispose on server death"*

---

### Task 7: The `lens` tool honors Esc and reports honestly (P0 #2)

**Files:**
- Modify: `lens/src/tools.ts`
- Modify: `lens/test/tools.test.ts`

**Behavior:**
- The `_signal` parameter is used, not discarded: it is combined with the request deadline via `deadline(REQUEST_TIMEOUT_MS, signal)` and passed to the client.
- `_ctx` is used to resolve cwd via `cwdOf(ctx)` for the `ready()` call.
- `LspUnavailableError` propagates — throwing is Pi's only way to set `isError`, and the agent must learn the server did not answer rather than seeing `(none found)`.

- [ ] **Step 1 — Failing tests.** Cases: aborting the passed signal mid-query rejects within `within(...)`; a wedged server produces an error whose message says the server did not respond and does **not** say "none found"; a successful `references` still formats `file:line:col`; `rename` without `new_name` still throws its argument error.
- [ ] **Step 2 — Run, confirm failure** — abort is currently ignored, so the test hangs to `within`'s bound.
- [ ] **Step 3 — Implement** signal threading and cwd resolution.
- [ ] **Step 4 — Verify** `test/contract.test.ts` still passes: the tool name, description, and `promptSnippet` are untouched.
- [ ] **Step 5 — Commit.** *"lens: honor the tool abort signal; never report a wedged server as empty"*

---

### Task 8: `lens/index.ts` — session cwd, trust gate, bounded verify (D3, D5 — P0 #4, #7)

**Files:**
- Modify: `lens/index.ts`, `lens/src/linters.ts`, `lens/src/config.ts`
- Modify: `lens/test/wiring.test.ts`, `lens/test/linters.test.ts`

**Interfaces — Produces:**
```ts
// lens/src/linters.ts — signature unchanged; now forwards { cwd, timeout }
export const LINTER_TIMEOUT_MS = 30_000;
// lens/src/config.ts
verifyTimeoutMs: number;   // default 600_000
```

**Behavior:**
- Delete `const cwd = process.cwd()` (line 34). Every site resolves `cwdOf(ctx)`: `manager.ready`/`pull`, `autodetectVerify`, `runVerify`, and the command's `detectVerify` dep (which becomes `(cwd: string) => string | null`, resolved from the command handler's ctx — `ExtensionCommandContext extends ExtensionContext`, so `sessionManager` is available).
- `runLinters` forwards `{ cwd, timeout: LINTER_TIMEOUT_MS }` to `exec`. It already receives `cwd` and uses it only for `enabledFor` gating.
- `runVerify` is called with `ctx?.signal` and `{ timeout: cfg.verifyTimeoutMs }`.
- **Trust gate:** on `agent_settled`, when `ctx.isProjectTrusted()` is false, an **autodetected** command is skipped and an **explicitly configured** `cfg.verifyCmd` still runs. A skip emits a one-time notice — an invisible safety gate reads as a broken feature.

- [ ] **Step 1 — Failing wiring tests** against the fake `ExtensionAPI`. Cases: with a fake ctx reporting cwd `/tmp/x`, the manager and verify both receive `/tmp/x`, not `process.cwd()`; untrusted + autodetected ⇒ `exec` never called; untrusted + configured `verifyCmd` ⇒ `exec` called; trusted + autodetected ⇒ called; the untrusted skip notifies exactly once across two settles. Linter test: `exec` receives `{ cwd }` matching the argument.
- [ ] **Step 2 — Run, confirm failure** — `isProjectTrusted` is called nowhere in the suite; linters pass no options.
- [ ] **Step 3 — Implement** cwd threading, then the trust gate, then linter/verify options.
- [ ] **Step 4 — Verify** the `!ctx.hasUI` guard on the `sendMessage` path is untouched — removing it makes `pi -p` hang forever.
- [ ] **Step 5 — Commit.** *"lens: act on the session cwd, gate autodetected verify on project trust"*

---

### Task 9: The remaining `cwdOf` sites (D3, D12)

**Files:**
- Modify: `memory/index.ts:28,48,59,60`, `memory/src/tools.ts:14`, `spawn/index.ts:34`, `spawn/src/tools.ts:57`, `git/index.ts:18`
- Modify: `memory/src/command.ts`, `spawn/src/command.ts`
- Modify: `memory/test/wiring.test.ts`, `spawn/test/wiring.test.ts`

**Behavior:**
- All four copy-pasted correct idioms collapse to `cwdOf`.
- Command deps widen to take `cwd`: `listMemories: (cwd: string) => Memory[]`, `deleteMemory: (name: string, cwd: string) => void`, `listAgents: (cwd: string) => AgentDef[]`, resolved at invoke time from the handler's ctx.
- **`memory/index.ts:48` is the one site `cwdOf` cannot fix** — it sits in a `pi.events.on("verify:failed")` bus callback, which receives only `data` and no ctx. The extension records the session cwd when its `context` hook runs and uses that; if no cwd has been observed yet, the auto-capture write is skipped rather than guessing. Putting `cwd` in the event payload is the better long-term fix and belongs to sub-project 3.
- Delete the `process.chdir()` workaround and the `KNOWN DEFECT` marker in `memory/test/wiring.test.ts` — this task is the fix it was waiting for.

- [ ] **Step 1 — Failing tests.** Cases: with a fake ctx reporting `/tmp/session`, memory's `context` hook lists from `/tmp/session`; auto-capture on `verify:failed` writes under `/tmp/session` after a `context` hook has run; auto-capture **before** any `context` hook writes nothing at all (rather than writing to `process.cwd()`); spawn's `listAgents` and memory's command deps receive the ctx cwd.
- [ ] **Step 2 — Run, confirm failure** — auto-capture currently writes into `process.cwd()`, which is what polluted the repo with `.pi/memory/`.
- [ ] **Step 3 — Implement** `cwdOf` everywhere, the cwd cache, and the widened command deps.
- [ ] **Step 4 — Verify** no `.pi/` directory appears in the repo after `bun test`.
- [ ] **Step 5 — Commit.** *"memory, spawn, git: resolve the session cwd everywhere (fixes auto-capture writing to process.cwd)"*

---

### Task 10: Spawn job deadline

**Files:**
- Modify: `spawn/src/runner.ts`, `spawn/src/config.ts`
- Modify: `spawn/test/runner.test.ts`

**Interfaces — Produces:**
```ts
// spawn/src/config.ts
jobTimeoutMs: number;   // default 900_000 (15 min)
```

**Behavior:** each job's signal becomes `deadline(cfg.jobTimeoutMs, signal)`, reusing the existing SIGTERM→SIGKILL escalation (`runner.ts:123-131`) rather than adding a second kill path. A job killed at its deadline reports that fact rather than appearing to finish empty (same rule as D2/D7).

- [ ] **Step 1 — Failing test.** A child that never exits is terminated at an injected 50 ms deadline and its result says it timed out; wrap in `within(...)`.
- [ ] **Step 2 — Run, confirm failure** — no deadline exists, so the test hangs to `within`'s bound.
- [ ] **Step 3 — Implement** the combined signal and the timeout-aware result.
- [ ] **Step 4 — Verify** user-initiated abort still works and is distinguishable from a deadline kill.
- [ ] **Step 5 — Commit.** *"spawn: bound each job with a deadline"*

---

### Task 11: Truncation at the agent-facing boundaries (D6)

**Files:**
- Modify: `lens/src/diagnostics.ts`, `lens/src/verify.ts`, `consult/src/`, `browser/src/`, `spawn/src/render.ts`, `memory/src/recall.ts`
- Modify: the corresponding test files

**Behavior:** every string that reaches the model passes through `truncateForAgent` with a `label`. `keep: "tail"` for verify output and subagent output — the failure is at the end; `keep: "head"` elsewhere. Pi's docs state tools MUST truncate, and the suite currently has zero truncation anywhere.

- [ ] **Step 1 — Failing tests**, one per boundary: an oversized input is truncated and carries a marker; a normal-sized input is returned byte-identical (no marker, no trailing-whitespace change).
- [ ] **Step 2 — Run, confirm failure** — output is currently unbounded at every boundary.
- [ ] **Step 3 — Implement**, choosing `head`/`tail` per boundary as above.
- [ ] **Step 4 — Verify** the `<pi-*>` injection block format is unchanged when nothing is truncated — `shared/tags.ts` consumers depend on it.
- [ ] **Step 5 — Commit.** *"Truncate every agent-facing output through one renderer"*

---

### Task 12: Make the cwd bug class a CI failure (D3)

**Files:**
- Modify: `test/boundaries.test.ts`

**Behavior:** a source scan asserting `process.cwd()` appears nowhere outside `shared/cwd.ts` and `**/test/**`. The five broken sites existed because a correct idiom was copy-pasted four times and missed five places; deduplication alone does not prevent recurrence. This lands **last in wave 2** so it goes green immediately, in the same style as sub-project 1's doc-drift guards. Note this cannot be an ESLint rule: adding an ESLint config would change pi-lens's own behavior, since it gates its linter on config presence.

- [ ] **Step 1 — Write the guard** and run it — it should pass, because Tasks 8 and 9 removed every offender.
- [ ] **Step 2 — Prove it bites.** Temporarily reintroduce a bare `process.cwd()` in an extension, confirm the test fails, revert. A guard never seen failing is not known to work.
- [ ] **Step 3 — Verify** the allowlist covers `shared/cwd.ts` and test files only.
- [ ] **Step 4 — Commit.** *"Guard against bare process.cwd() outside shared/cwd.ts"*

---

# Wave 3 — pi-git Rebuild

*Independent of wave 2. Larger than the other waves — a storage rewrite, not a patch — and the natural place to stop and re-evaluate if waves 1–2 ran long.*

### Task 13: Memory index cache (D9)

**Files:**
- Modify: `memory/src/store.ts`
- Modify: `memory/test/store.test.ts`

**Interfaces — Produces:**
```ts
export function listMemories(cwd: string): Memory[];       // cached
export function invalidateIndexCache(cwd?: string): void;  // all scopes when omitted
```

**Behavior:** the `context` hook calls `listMemories` on **every LLM call**, re-reading every memory file each time. The cache is keyed by cwd and revalidated by a `stat` of the memory directories — one stat instead of N reads. `writeMemory`/`deleteMemory` invalidate explicitly; the mtime check additionally covers edits made by another process or by hand, which in-process invalidation alone would miss. Injection stays at `messages[0]`: the defect was the disk re-read, not the placement.

- [ ] **Step 1 — Failing tests.** Cases: a second `listMemories` with an unchanged directory performs no file reads (count them via an injected reader or a spy); a write then re-list returns the new content; touching a file's mtime externally busts the cache; two different cwds do not share entries.
- [ ] **Step 2 — Run, confirm failure** — every call currently reads every file.
- [ ] **Step 3 — Implement** the cache and both invalidation paths.
- [ ] **Step 4 — Commit.** *"memory: cache the index, revalidated by directory mtime"*

---

### Task 14: The checkpoint store (D10)

**Files:**
- Create: `git/src/store.ts`, `git/test/store.test.ts`

**Interfaces — Produces:**
```ts
export type FileState = { hash: string } | { absent: true };
export type Manifest = Record<string, FileState>;   // absolute path → state

export interface CheckpointStore {
  checkpoint(entryId: string, paths: readonly string[]): Promise<Manifest>;
  rememberOrigin(path: string): Promise<void>;
  restore(entryId: string): Promise<{ written: string[]; removed: string[] }>;
  has(entryId: string): Promise<boolean>;
  tracked(): readonly string[];
  gc(ttlDays: number, nowMs: number): Promise<{ sessions: number; blobs: number }>;
}
export interface StoreOptions {
  /** Defaults to `<agentDir()>/checkpoints`. Injected in tests. */
  root?: string;
  /** Files larger than this are skipped and reported. Default 10_485_760 (10 MB). */
  maxFileBytes?: number;
}
export function createStore(sessionId: string, opts?: StoreOptions): CheckpointStore;
```

**Consumes:** `agentDir()` from `shared/config.ts` (already honors `PI_CODING_AGENT_DIR`).

**Behavior — this is the task that fixes P0 #6:**
- Layout: `<agentDir()>/checkpoints/<sessionId>/<entryId>.json` for manifests, `<agentDir()>/checkpoints/blobs/<sha256>` for content. Blobs are shared across sessions, so identical content checkpointed in ten sessions is stored once.
- Keys are **absolute paths**. A path has no root and therefore no work-tree boundary, which is precisely why nested repositories stop being a special case.
- `rememberOrigin(path)` records the file's state the first time pi-git sees it — hash, or `{ absent: true }` if it does not exist — and never overwrites an existing origin.
- `restore(entryId)` writes, for every tracked path, `manifest[entryId][path]` when that entry recorded it and `origin[path]` otherwise. `{ absent: true }` means delete. A path first tracked *after* the target entry therefore returns to its pre-Pi state rather than being ignored or wrongly deleted — and no back-filling of earlier manifests is needed.
- Restore prunes directories left empty by its own deletions. Parent directories are created for writes.
- Files above `opts.maxFileBytes` are skipped and reported, not silently dropped. Task 16 passes `cfg.maxFileBytes` through; the default lives here so the store is usable standalone in its own tests.
- `gc` deletes session directories older than `ttlDays`, then sweeps blobs unreferenced by any surviving manifest. `nowMs` is injected so the TTL is testable without waiting or stubbing globals.

- [ ] **Step 1 — Failing tests** against a temp root. Cases: checkpoint then modify then restore returns the original bytes; a file created after entry X is deleted when restoring to X; a file that existed before pi-git saw it restores to its origin rather than being deleted; identical content in two checkpoints writes one blob; **the nested case — two paths under different repositories both restore**, which is the spec's headline acceptance criterion; restore removes directories its own deletions emptied; a file over `maxFileBytes` is skipped and named; `gc` prunes an old session and its now-unreferenced blobs while keeping blobs a live session still references.
- [ ] **Step 2 — Run, confirm failure** — module not found.
- [ ] **Step 3 — Implement.** Pure filesystem plus `node:crypto` for sha256. No git, no subprocess.
- [ ] **Step 4 — Verify** nothing is written outside the store root — the store must never touch the project tree except through `restore`.
- [ ] **Step 5 — Commit.** *"git: add a content-addressed checkpoint store keyed by absolute path"*

---

### Task 15: Change detection and the git environment scrub (D13, D14)

**Files:**
- Create: `git/src/detect.ts`, `git/test/detect.test.ts`
- Modify: `git/src/git.ts` (env scrub in `createGit`)

**Interfaces — Produces:**
```ts
export function isRepo(exec: ExecFn, cwd: string): Promise<boolean>;
export function dirtyPaths(exec: ExecFn, cwd: string): Promise<string[]>;   // absolute; [] when not a repo
export const SCRUBBED_GIT_ENV: Readonly<Record<string, undefined>>;
```

**Behavior:**
- `dirtyPaths` runs `git status --porcelain` and returns absolute paths, so its output composes directly with the store's key space. Read-only: no index, no objects, no refs, no restore.
- `SCRUBBED_GIT_ENV` unsets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE` on every git invocation, using Task 2's env-unset support. Repository identity comes from `cwd` alone.
- Scrubbing is applied once at the `createGit`/`detect` boundary rather than per call site: a single forgotten call is exactly how this bug class survives.
- Rename-status lines (`R old -> new`) yield both paths, so a rename is restorable from either side.

- [ ] **Step 1 — Failing tests** against real temp repositories. Cases: a modified tracked file, an untracked file, and a deleted file all appear in `dirtyPaths`; an ignored file does not; a non-repo directory returns `[]` rather than throwing; **with `GIT_DIR` and `GIT_INDEX_FILE` pointed at a decoy repository, `dirtyPaths` still reports `cwd`'s repository and the decoy's index is byte-identical afterward** — this is OpenCode issue #22477 reproduced; a rename yields both paths.
- [ ] **Step 2 — Run, confirm failure** — module not found; the decoy test additionally fails against the current `createGit`.
- [ ] **Step 3 — Implement** `detect.ts` and the scrub.
- [ ] **Step 4 — Commit.** *"git: enumerate dirty paths read-only; scrub inherited git environment"*

---

### Task 16: Wire the hooks; delete the tree machinery (D10, D14)

**Files:**
- Modify: `git/index.ts`, `git/src/hooks.ts`, `git/src/config.ts`
- Delete from: `git/src/git.ts`, `git/src/checkpoints.ts`, and their tests
- Modify: `git/test/wiring.test.ts`

**Interfaces — Produces:**
```ts
// git/src/config.ts
checkpointTtlDays: number;   // default 30
detectDirty: boolean;        // default true
maxFileBytes: number;        // default 10_485_760
```

**Behavior — four hooks:**
- `tool_call` on `write`/`edit` → `store.rememberOrigin(absolutePath)`. Fires **before** the tool executes and carries typed `input`, so the pre-edit bytes are readable at exactly the right moment.
- `message_start` (existing, unchanged dedup by entry id) → `store.checkpoint(entryId, paths)`.
- `session_before_tree` → checkpoint at `currentUserEntryId(sm)` before navigating, so the state being left is preserved and nothing is discarded unrecoverably.
- `session_tree` → `store.restore(currentUserEntryId(sm))` after navigating. Forward navigation now behaves exactly like backward — redo by symmetry.
- The existing fork pair keeps working, now restoring through the store.
- `paths` = `store.tracked()` ∪ `dirtyPaths(...)` when `cfg.detectDirty` and the directory is a repository.
- Taking the checkpoint in `session_before_tree` rather than deriving it from `session_tree`'s `oldLeafId` is deliberate: checkpoints key on *user-message* entry ids while the event carries *leaf* ids, which may be assistant entries. Both hooks reuse `currentUserEntryId` unchanged.
- Then delete `snapshotTree`, `restoreTree`, `updateRef`, `readRef`, `listRefs`, `checkpointRef`, `findCheckpoint`, `restoreTo`, `withTempIndex` and their tests. `currentUserEntryId` survives. The worktree functions stay — already dead, already out of scope.

- [ ] **Step 1 — Failing wiring tests** against the fake `ExtensionAPI`. Cases: a `tool_call` for `edit` records an origin; `session_before_tree` then `session_tree` restores the target entry's files; navigating forward restores too; **a session rooted at a temp dir containing a nested repo, with one file edited on each side, restores both** — the acceptance criterion; a bash-created file is picked up via `dirtyPaths` inside a repo; in a non-repo directory checkpointing still works via tool-tracked paths alone and the directory gains no `.git`.
- [ ] **Step 2 — Run, confirm failure.**
- [ ] **Step 3 — Implement** the hooks, then delete the dead machinery in the same task — leaving it would make `test/boundaries.test.ts` and the reader believe two storage models coexist.
- [ ] **Step 4 — Verify** `/pi-git` gained no arguments and still opens settings (D11), and that `test/contract.test.ts` passes untouched.
- [ ] **Step 5 — Commit.** *"git: follow the session tree via per-file checkpoints; delete tree snapshots"*

---

### Task 17: Checkpoint GC (D10)

**Files:**
- Modify: `git/index.ts`
- Modify: `git/test/wiring.test.ts`

**Behavior:** `store.gc(cfg.checkpointTtlDays, Date.now())` runs on `session_start`, best-effort and never blocking startup. Age-based, not a count cap: with navigation able to reach arbitrarily far back, pruning the newest-N would silently break a still-reachable restore.

**This is the only step a revert cannot undo**, because it deletes data. It ships last and is exercised against a throwaway store before being pointed at a real one.

- [ ] **Step 1 — Failing test.** With an injected `nowMs` far in the future, an old session directory and its unreferenced blobs are pruned while a recent session and its blobs survive.
- [ ] **Step 2 — Run, confirm failure** — `gc` has no caller.
- [ ] **Step 3 — Implement** the `session_start` call.
- [ ] **Step 4 — Manual check** against a scratch store: run twice, confirm the second run is a no-op and that nothing outside the store root is touched.
- [ ] **Step 5 — Commit.** *"git: prune checkpoints older than the TTL on session start"*

---

### Task 18: Full verification

**Files:** none — this task only runs things.

- [ ] **Step 1 — Suite.** `bun test` green; `bunx tsc --noEmit` clean.
- [ ] **Step 2 — Install smoke.** `./scripts/smoke-install.sh` — a clean clone plus `npm install --omit=dev` plus loading all seven. This is the test that would have caught the packaging break behind sub-project 1.
- [ ] **Step 3 — Contract.** Confirm `test/contract.test.ts` and `shared/surface.ts` are byte-identical to their state before this sub-project. Any change means the agent surface moved, which was out of scope.
- [ ] **Step 4 — tmux dogfood**, driving a real Pi TUI: the trust gate in an untrusted repo; an LSP timeout against a wedged server; `/tree` navigation in both directions with file changes following; a session in a non-git directory; and **a session rooted at `~/dev/pi` editing inside `~/dev/pi/pi-suite`** — the case that motivated the storage rewrite.
- [ ] **Step 5 — Print-mode check.** `pi -p 'hello'` returns instead of hanging, confirming no injection or turn-trigger was added without a `ctx.hasUI` guard.
- [ ] **Step 6 — Update** `docs/HOUSE-STYLE.md` only where this sub-project changed behavior it documents; leave §7 and §9 alone — they are sub-project 3's subject.
- [ ] **Step 7 — Commit and push.**

---

## Notes for the implementer

**Why the LSP fix goes in `request()` and nowhere else.** A previous attempt (`30561bf`) bounded process *spawning* — a `which` check plus an `onDead` handler. It prevents spawning an absent binary and does not bound a request; the hang survived it. `request()` is the only scope holding both the `pending` map and the request id, so it is the only place that can settle the promise *and* remove the entry. **Bound the await where its state lives.**

**Why timeouts reject instead of resolving empty.** `references` on a wedged server resolving `[]` renders as `(none found)` — a confident, wrong answer the agent then acts on. The same rule drives `ExecResult.killed`: never report a bounded wait as a normal result. If a fix makes a failure look like a success, it is not a fix.

**Why per-file storage.** Reproduced with the exact plumbing `git.ts` uses: with a session rooted at a directory containing a nested repository, `git add -A` records the inner repo as a gitlink (`160000`) and captures none of its contents, so a restore reverts the outer file and leaves the inner one edited — a silent half-restore. Absolute paths have no root and therefore no boundary. Prior art agrees this is the hard case: of four Pi rewind extensions, two ignore it and the most mature (`@ayulab/pi-rewind`) excludes nested repositories entirely, documenting "start Pi in that repository root."

**Truncation utilities are importable from `@earendil-works/pi-coding-agent`, not `@earendil-works/pi-agent-core`.** The latter's `exports` map exposes only `.`, `./node`, and `./package.json`, so the deep path does not resolve. `pi-coding-agent` is already a peer dependency at `"*"`, so this adds no packaging risk.

**Testing bounded paths.** Always wrap in `within(ms, promise)` from `shared/test/harness.ts`. A hang test that lacks it does not fail — it stops the entire run, which reads as a hung CI job rather than a red test.
