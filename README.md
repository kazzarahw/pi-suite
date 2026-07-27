# pi-suite

A small, self-consistent, **agent-facing** extension suite for [Pi](https://pi.dev) — extensions built to cooperate *natively*, not a handful of third-party extensions that happen to share a namespace. One repo, one package, one install.

## The suite

| Extension | What it does | Agent tools |
|---|---|---|
| [`git/`](./git) | Automatic file checkpoints; moving through the session tree moves your files with it, forward and back. Works outside a git repository, and across nested ones | *none — pure hooks* |
| [`goal/`](./goal) | The session's north-star: one objective, kept in context every turn so long work does not drift | `goal` |
| [`lens/`](./lens) | Real-time LSP + linter diagnostics (multi-language) injected after edits, opt-in auto-format, and an automatic test/verify pass | `lens` *(action enum)* |
| [`memory/`](./memory) | Persistent write-back memory: record durable learnings, recall them across sessions | `memory` *(action enum)* |
| [`spawn/`](./spawn) | Delegate tasks to isolated subagents, one or many in parallel | `spawn` |
| [`todo/`](./todo) | The agent's task list, rendered as a live widget | `todo` |
| [`browser/`](./browser) | The web in one tool (wrapping `agent-browser`): search, fetch/read, snapshot with `@ref`s, click/type | `browser` *(action enum)* |

**One tool per extension, named after the extension** — `memory`, `todo`, `goal`, `spawn`, `browser`, `lens`, each alongside its `/pi-<name>` command, and pi-git with none at all. That is the whole surface, and it is the rule rather than a coincidence: `test/contract.test.ts` fails an extension that registers a second tool name. The rules that keep it small are in [`shared/README.md`](./shared/README.md): automatic behavior is a hook rather than a tool; a domain with several verbs dispatches on an `action` enum instead of minting a name per verb; and read paths are covered by tool-result echoes and context injection instead of extra read tools.

Each extension is a **peer**, not a component: any one can be disabled, replaced, or prototyped against without touching the others. The only coupling permitted is `shared/` and the `pi.events` bus — never a direct import between extensions.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

That installs all of them. Use `pi config` to enable or disable individual extensions, or narrow them in `settings.json` with package filtering.

To **drop or replace one in the repo**, edit `SURFACE` in [`shared/surface.ts`](./shared/surface.ts); `package.json`'s `pi.extensions` is derived from it and checked against it. Nothing else needs touching — no test asserts a particular extension count, so the suite stays green with any subset.

## Layout

```
pi-suite/
├── package.json          # ONE pi manifest listing every entry point
├── shared/               # the internal library (see below) + its README
├── <name>/               # one dir per extension: index.ts, src/, test/, README.md
├── test/                 # repo-wide guards: contract + boundaries
└── scripts/              # smoke-install.sh
```

Documentation lives with what it documents: [`shared/README.md`](./shared/README.md) is
the contract you write an extension against, and each `<name>/README.md` describes that
one extension. There is no suite-wide design document — the previous one drifted from the
code three times, and the rules worth keeping are the ones a test can enforce.

### `shared/`

An **internal module**, imported by relative path — not a package and not a dependency. Pi installs with `npm install --omit=dev`, so anything imported at runtime from `devDependencies` is absent on a real install; keeping the shared code internal removes that failure mode entirely rather than working around it.

| Module | Contents |
|---|---|
| `mode.ts` | the universal `off \| notify \| block` enforcement dial |
| `nudge.ts` | the settle-time nudge decision, and the no-progress guard for `block` |
| `events.ts` | the `domain:event` vocabulary and payload types |
| `tags.ts` | the `<pi-*>` context-injection format |
| `surface.ts` | the agent-surface SSOT — one entry per extension |
| `config.ts` | config paths (via Pi's own `getAgentDir`/`CONFIG_DIR_NAME`); each extension keeps its own validation |
| `fields.ts` | config field validators, so every `parse` agrees on what's valid |
| `settings-panel.ts` | the shared `/pi-<name>` settings panel |
| `exec.ts` | the subprocess runner — always resolves, never rejects |
| `cwd.ts` | `cwdOf(ctx)` — the only permitted working-directory resolution |
| `trust.ts` | `projectTrusted(ctx)` — the gate on anything the repository supplied |
| `deadline.ts` | a timeout composed with the caller's abort signal, distinguishably |
| `truncate.ts` | agent-facing truncation, over Pi's own utilities |
| `frontmatter.ts` | `---`-delimited markdown (memories, agent definitions) |
| `hash.ts` | `stableHash` — short, stable, non-cryptographic string hash |
| `tool-input.ts` | `editedPath(input)` + the `EDIT_TOOLS` / `FILE_TOOLS` sets |
| `test/harness.ts` | a fake `ExtensionAPI` for testing extension wiring |

Full contract and the rules for writing an extension: [`shared/README.md`](./shared/README.md).

`shared/` is a leaf: it never imports from an extension, and extensions never import from each other. Enforced by `test/boundaries.test.ts`.

### Load order

Fixed by `SURFACE`, which `package.json` mirrors: `memory, todo, goal, git, spawn, browser, lens`. It is significant — `tool_result` handlers chain as middleware in load order, so the extension that augments other extensions' output must come last. pi-lens declares this with `wrapsToolResult: true` rather than the ordering being folklore, and `test/contract.test.ts` enforces it for whichever extension declares it.

## Development

```sh
bun install
bun test                    # unit, wiring, contract, and boundary tests + the coverage floor
bunx tsc --noEmit
./scripts/smoke-install.sh  # clean clone + npm install --omit=dev + load every extension
```

CI runs all of these on every push. `bun test` enforces a **per-file** coverage floor
(see [`bunfig.toml`](./bunfig.toml)) — a floor on the worst file rather than an average,
because an average hides one untested file behind a hundred tested ones.

### The guards

Four test layers exist because of specific failures, not as ceremony:

- **Wiring tests** (`<name>/test/wiring.test.ts`) exercise each `index.ts` — hooks, guards, cwd resolution. This layer had no coverage originally, and it is where several defects lived. It pins the `!ctx.hasUI` guard in particular: injecting a message with no interactive UI makes Pi wait forever for a prompt that never arrives.
- **Contract tests** (`test/contract.test.ts`) assert the live registry matches `shared/surface.ts`, that every emitted event exists in `EVENTS`, and that each extension's own README documents the tools it registers. Docs are checked against the code, never the reverse — earlier versions claimed a wrong tool count and a capability that was dead code. Note that the prose counts on this page are *not* checked, which is exactly why nothing in the code depends on them.
- **Install smoke test** (`scripts/smoke-install.sh`) reproduces a real install and asserts every declared extension loads. This is the test that would have caught the packaging break that prompted the consolidation.
- **Structural guards** (`test/boundaries.test.ts`) are source scans, each with a case proving it can fail: no cross-extension imports, no `process.cwd()` outside `shared/cwd.ts`, no second copy of a shared helper, no module unreachable from its `index.ts`, no duplicate imports, and the standard directory shape. Every one of them exists because the thing it forbids already happened once.

AGPL-3.0.
