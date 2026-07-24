# pi-suite Consolidation — Design

**Date:** 2026-07-24
**Status:** approved, pending implementation plan
**Scope:** sub-project 1 of 4 (see *Program context*)

---

## Program context

A review of the seven-extension suite found defects across three axes: correctness
bugs, a contract that has drifted from the code, and large parts of Pi's extension
API left unused. The work was decomposed into four sub-projects, to be built in
order, each with its own spec → plan → implementation cycle:

1. **Consolidation** *(this document)* — one repo, one package, shared internals,
   CI. Absorbs the P0 packaging break.
2. **Correctness hardening** — the P0/P1 defect list (LSP request bound, output
   truncation, `cwd` correctness, git restore-undo + ref GC, memory cache/perf,
   trust checks, spawn timeout).
3. **Contract reconciliation + cooperation layer** — what `mode: "block"` means,
   which events earn subscribers, whether config moves to Pi's `settings.json`,
   restoring HOUSE-STYLE as an enforceable contract.
4. **Pi-integration polish** — `promptGuidelines`, `renderCall`/`renderResult`,
   `onUpdate` streaming, `resources_discover`.

Consolidation goes first because every fix in sub-project 2 is otherwise done
seven times, and sub-project 3 cannot be designed sensibly until the code has a
single home.

---

## Problem

**The suite is currently un-installable from git.** Six of seven extensions import
runtime values (`MODES`, `DEFAULT_MODE`, `TODO_STATUSES`, `injectionBlock`,
`injectionHeader`) from `pi-shared`, which is declared as a `devDependency`. Pi's
`extensions.md` documents that package installation uses `npm install --omit=dev`,
so `devDependencies` are absent at runtime. Verified empirically: a clean clone of
`pi-todo` installed this way fails with `Cannot find package 'pi-shared'`.

This works today only because local-path installs reuse an existing `node_modules`.
Since the stated distribution method is `pi install git:github.com/kazzarahw/pi-*`,
this is a live break, not a latent one.

Three structural problems compound it:

- **Sevenfold duplication.** `loadConfig`/`saveConfig`, `openSettingsPanel`, and
  `ExecFn`/`defaultExec` are copy-pasted per repo. Every sub-project-2 fix would be
  applied seven times.
- **A publish loop.** Editing `pi-shared` requires commit → push → `bun update` ×7.
- **No CI in any repo, and zero test coverage of the wiring layer.** All 152 tests
  are pure-unit tests on extracted modules; `index.ts` — where every hook, guard,
  and `cwd` decision lives, and where the review's findings 5, 7, and 9 all
  originate — is untested in all seven repos.

---

## Decisions

### D1 — One repo, one package, seven extensions

A new `github.com/kazzarahw/pi-suite` holding all seven extensions plus a `shared/`
internal module. The existing eight repos are **archived, not deleted**, after
pi-suite is verified green.

*Verified:* a single package declaring multiple `pi.extensions` entry points
registers all of them, and they may share an internal module via relative import
(probe: two extensions, one shared file, both tools registered under `pi -e`).

*Rationale:* `shared/` as a relative import means there is no package to omit, which
removes the P0 failure class entirely rather than working around it. It also
collapses the duplication, kills the publish loop, and reduces eight CI configs and
eight pinned refs to one.

### D2 — Rejected: Bun workspace monorepo

Workspaces give tool-enforced package boundaries, but Pi installs the **repo root**
as the package, so `pi-shared` would still need to resolve at runtime through
workspace symlinks under `npm install --omit=dev`, plus `bundledDependencies`
interplay. That is the same machinery that produced the current P0. The benefit
(enforced boundaries) is obtainable from a lint rule; the cost is reintroducing the
failure mode this sub-project exists to eliminate.

### D3 — Rejected: pure relocation without dedup

Smallest diff and trivially behavior-preserving, but leaves all seven duplicated
helpers in place — defeating the main reason consolidation is sequenced first.

### D4 — Rejected: a `pi-meta` repo

Adds a coordination point while removing no duplication and leaving the publish loop
intact. `pi-shared/README.md` already serves as the suite hub.

### D5 — Behavior preservation, and its two exceptions

The migration is behavior-preserving **except where dedup forces convergence**. Two
such points, both resolved toward the more-correct behavior and both recorded in the
migration notes:

| Divergence | Today | After |
|---|---|---|
| `PI_CODING_AGENT_DIR` | honored by pi-lens, pi-memory; ignored by the other five | honored by all seven |
| `execFile` `maxBuffer` | 32MB (lens, consult) / 64MB (git, browser) | 64MB for all |

No other behavior changes. Config file paths and semantics are otherwise untouched.

### D6 — Deliberate extension load order

`package.json` now controls load order, which governs `tool_result` middleware
chaining and `before_agent_start` system-prompt chaining. Order:
`memory, todo, git, consult, spawn, browser, lens` — **lens last**, so its
diagnostics injection is the outermost `tool_result` wrapper and observes any
content earlier handlers added.

Only pi-lens registers `tool_result` today, so this is currently a no-op — but a
deliberate one, replacing what is presently an accident of settings ordering.

### D7 — Enforced import boundaries

A single package removes the structural barrier between extensions. A lint rule
restores it: an extension directory may import from `shared/` and its own `src/`,
and nothing else. Cross-extension coupling, if it is ever wanted, belongs on the
event bus (sub-project 3), not in an import.

### D8 — Test strategy: preserve as guard, merge where forced, add a layer

The existing suite was assessed rather than assumed weak. `pi-git/test/git.test.ts`
(real repos in tmpdir, round-tripping snapshot/restore including the `.gitignore` and
post-snapshot-removal edge cases), `pi-lens/test/manager.test.ts` (a `within()` helper
that turns a hang into a failure, pinning the missing-binary regression), and
`pi-todo/test/state.test.ts` (id preservation, newly-completed detection) are all
genuinely valuable. The deficiency is **coverage shape, not quality**: all 152 tests
sit below the wiring layer and none at it — which is precisely why the review's
hook-layer findings went unnoticed.

Therefore:

- **Unchanged during the move.** They are the behavior-preservation guard, and
  rewriting tests and moving code simultaneously destroys the evidence that the move
  was clean.
- **Merged where dedup forces it.** Seven near-identical `config.test.ts` files
  become one parameterized suite over `ConfigSpec`, because there is now one config
  module. Same for the `exec` tests. Assertions carry over; they are not rewritten.
- **A layer is added, not substituted** (see *Verification*).
- **Quality upgrades are deferred to sub-project 2**, where a better test naturally
  accompanies the fix it covers. Rewriting lens/spawn/memory tests before those fixes
  exist would mean writing them twice.

### D9 — Blast radius is unchanged by consolidation

*Verified:* Pi aborts startup entirely when any extension's factory throws — both
for one multi-extension package and for separate single-extension packages. The
control test rules out the main structural objection to D1.

---

## Interfaces

### `shared/config.ts`

Mechanism shared, policy local. Path resolution, read/write, `mkdir -p`, and
corrupt-file→defaults are shared; field validation stays per-extension because the
config shapes genuinely differ (lens's `verifyCmd`/`autoFormat`/`prewarm` vs git's
nested `worktrees`).

```ts
export interface ConfigSpec<T> {
  name: string;                          // "lens" → <agentDir>/pi-lens.json
  defaults: T;
  parse(raw: unknown, defaults: T): T;   // per-extension validation
}

export function configPath(name: string): string;       // honors PI_CODING_AGENT_DIR
export function loadConfig<T>(spec: ConfigSpec<T>): T;   // never throws → defaults
export function saveConfig<T>(spec: ConfigSpec<T>, cfg: T): void;
```

### `shared/settings-panel.ts`

Verbatim extraction of the seven-times-duplicated helper. Signature unchanged from
the current per-repo copies.

```ts
export function openSettingsPanel(
  ctx: ExtensionCommandContext,
  title: string,
  subtitle: string,
  items: SettingItem[],
  apply: (id: string, value: string) => void,
): Promise<void>;
```

**Retain the width-clipping**, with a comment recording why: a custom `ctx.ui.custom`
render wider than the terminal crashes Pi (`Rendered line N exceeds terminal width`).
An unexplained `clip()` is the kind of thing a later cleanup removes.

### `shared/exec.ts`

Union of the four current variants' option sets; all four already share the
resolve-never-reject, map-error→exit-code shape.

```ts
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const defaultExec: ExecFn;   // maxBuffer 64MB (see D5)
```

`timeoutMs` is deliberately **not** added here — process timeouts are sub-project 2.

### `shared/test/harness.ts`

A fake `ExtensionAPI` capturing registrations and hook subscriptions, so an
extension's `index.ts` can be exercised as a unit. First coverage the wiring layer
has had.

```ts
export interface FakeExtensionApi {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandOptions>;
  hooks: Map<string, Handler[]>;
  events: {
    emitted: Array<{ event: string; data: unknown }>;
    on(event: string, handler: (data: unknown) => void): void;
  };
  /** Invoke every handler registered for `hook`, returning the last non-undefined result. */
  fire(hook: string, event: unknown, ctx: unknown): Promise<unknown>;
}
export function createFakeApi(): FakeExtensionApi;
export function fakeCtx(overrides?: Partial<ExtensionContext>): ExtensionContext;
```

---

## Migration sequence

1. Create `pi-suite`; `git subtree add --prefix=<dir> <local-repo> main` for each of
   the eight → full commit history of every extension preserved. Note the prefix is
   the *destination directory*, which drops the `pi-` prefix and renames one repo:
   `pi-consult` → `consult/`, …, `pi-lens` → `lens/`, and `pi-shared` → `shared/`.
2. Single `consolidate` commit: eight manifests → one (with D6 load order); rewrite
   `from "pi-shared"` → `from "../shared/…"`; extract the three shared helpers;
   one `tsconfig.json`.
3. Relocate suite-level docs (`HOUSE-STYLE.md`, this spec) to a top-level `docs/`.
4. Add CI, the wiring harness, the contract test, and the install smoke test.
5. Verify (below), then cut local installs over: `pi remove` ×7 →
   `pi install /home/kazzarah/dev/pi/pi-suite`. Old working dirs stay on disk.
6. Archive the eight GitHub repos only after the live dogfood passes.

---

## Verification & acceptance

**The existing tests are the behavior-preservation guard** (see D8). Test *paths*
move; test *bodies* do not, with exactly one permitted exception: the seven
`config.test.ts` files and the duplicated `exec` tests merge into one parameterized
suite each, since they now cover one module. Assertions carry over verbatim. Any
*other* diff to a test body is a red flag requiring justification.

Expected count after merge: 152 minus the deduplicated config/exec cases, plus the
three new layers below. The exact number is an output of the migration, not a target
— but a *drop* in distinct assertions is a defect.

Three additions, in descending order of value:

- **Wiring-layer tests** (via `shared/test/harness.ts`) — per extension: registers
  the expected tools, subscribes to the expected hooks, and honors the `!ctx.hasUI`
  guard where applicable. This is where the review's findings 5, 7, and 9 live, and
  where sub-project 2's fixes will need coverage.
- **Contract test** — every event string emitted anywhere exists in `EVENTS`; every
  registered tool name matches the HOUSE-STYLE surface map; every extension
  registers exactly one `/pi-<name>` command. Makes doc drift a CI failure rather
  than something rediscovered in a dogfood weeks later — the process fix for the
  pattern that produced the current contradictions.
- **Install smoke test** — clean clone → `npm install --omit=dev` → load all seven
  entry points → assert seven extensions register. *This is the test that would
  have caught the P0*, and it runs on every push.

**Acceptance criteria:**

- [ ] All pre-existing tests pass; bodies unmodified except the permitted config/exec merge
- [ ] No net loss of distinct assertions versus the pre-migration suite
- [ ] `tsc --noEmit` clean across the consolidated tree
- [ ] Install smoke test passes (the P0 is provably fixed)
- [ ] Contract test passes
- [ ] Wiring tests cover all seven `index.ts` files
- [ ] Lint rule (D7) passes and fails on a deliberate cross-extension import
- [ ] Live tmux TUI dogfood (`tmux new-session -d -s pi …` + `send-keys` + `capture-pane`):
      all seven extensions exercised, all seven `/pi-*` panels opened, and at least one
      hook-driven behavior per extension confirmed on screen — not merely "pi started"
- [ ] `git log --follow` reaches pre-migration history for a file from each extension

---

## Out of scope

Deferred to sub-projects 2–4, and explicitly **not** to be smuggled in here: output
truncation, the LSP `request()` bound, the four `cwd` bugs, git restore-undo and ref
GC, memory index caching and cross-scope delete, project-trust checks, spawn
timeouts, `settings.json` migration, `mode: "block"` semantics, event-bus wiring,
`promptGuidelines`, and custom tool rendering.

---

## Rollback

Total and cheap: the eight repos are archived rather than deleted, the old working
directories remain on disk untouched, and the local-path installs revert with one
command. Recovery to the current state takes about a minute.
