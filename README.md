# pi-suite

A small, self-consistent, **agent-facing** extension suite for [Pi](https://pi.dev) — seven extensions built to cooperate *natively*, not seven third-party extensions that happen to share a namespace. One repo, one package, one install.

## The suite

| Extension | What it does | Agent tools |
|---|---|---|
| [`consult/`](./consult) | A second opinion — runs `claude --model` for read-only advice | `consult` |
| [`git/`](./git) | Automatic file checkpoints; moving through the session tree moves your files with it, forward and back. Works outside a git repository, and across nested ones | *none — pure hooks* |
| [`lens/`](./lens) | Real-time LSP + linter diagnostics (multi-language) injected after edits, opt-in auto-format, and an automatic test/verify pass | `lens` *(action enum)* |
| [`memory/`](./memory) | Persistent write-back memory: record durable learnings, recall them across sessions | `memory_recall`, `memory_write` |
| [`spawn/`](./spawn) | Delegate tasks to isolated subagents, one or many in parallel | `spawn` |
| [`todo/`](./todo) | The agent's task list, rendered as a live widget | `todo_write` |
| [`browser/`](./browser) | The web in one tool (wrapping `agent-browser`): search, fetch/read, snapshot with `@ref`s, click/type | `browser` *(action enum)* |

**Seven tools total** — a deliberately tight agent surface. The rules that keep it small are in [`docs/HOUSE-STYLE.md`](./docs/HOUSE-STYLE.md): automatic behavior is a hook rather than a tool; many variant actions collapse behind one `action`-enum tool; and read paths are covered by tool-result echoes and context injection instead of extra read tools.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

That installs all seven. Use `pi config` to enable or disable individual extensions, or narrow them in `settings.json` with package filtering.

## Layout

```
pi-suite/
├── package.json          # ONE pi manifest listing all 7 entry points
├── docs/HOUSE-STYLE.md   # the design contract
├── shared/               # internal module (see below)
├── <name>/               # one dir per extension: index.ts, src/, test/, README.md
├── test/                 # repo-wide guards: contract + boundaries
└── scripts/              # smoke-install.sh
```

### `shared/`

An **internal module**, imported by relative path — not a package and not a dependency. Pi installs with `npm install --omit=dev`, so anything imported at runtime from `devDependencies` is absent on a real install; keeping the shared code internal removes that failure mode entirely rather than working around it.

| Module | Contents |
|---|---|
| `mode.ts` | the universal `off \| notify \| block` enforcement dial |
| `events.ts` | the `domain:event` vocabulary and payload types |
| `tags.ts` | the `<pi-*>` context-injection format |
| `surface.ts` | the agent-surface SSOT — the docs are checked against this |
| `config.ts` | config mechanism; each extension keeps its own validation |
| `settings-panel.ts` | the shared `/pi-<name>` settings panel |
| `exec.ts` | the subprocess runner — always resolves, never rejects |
| `test/harness.ts` | a fake `ExtensionAPI` for testing extension wiring |

`shared/` is a leaf: it never imports from an extension, and extensions never import from each other. Enforced by `test/boundaries.test.ts`.

### Load order

`package.json` fixes the order: `memory, todo, git, consult, spawn, browser, lens`. It is significant — `tool_result` handlers chain as middleware in load order, so **lens loads last** and its diagnostics injection wraps outermost.

## Development

```sh
bun install
bun test                    # unit, wiring, contract, and boundary tests
bunx tsc --noEmit
./scripts/smoke-install.sh  # clean clone + npm install --omit=dev + load all seven
```

CI runs all four on every push.

### The guards

Three test layers exist because of specific failures, not as ceremony:

- **Wiring tests** (`<name>/test/wiring.test.ts`) exercise each `index.ts` — hooks, guards, cwd resolution. This layer had no coverage originally, and it is where several defects lived. It pins the `!ctx.hasUI` guard in particular: injecting a message with no interactive UI makes Pi wait forever for a prompt that never arrives.
- **Contract tests** (`test/contract.test.ts`) assert the live registry matches `shared/surface.ts`, that every emitted event exists in `EVENTS`, and that `HOUSE-STYLE.md` mentions every registered tool. The doc is checked against the code, never the reverse — earlier versions claimed a wrong tool count and a capability that was dead code.
- **Install smoke test** (`scripts/smoke-install.sh`) reproduces a real install and asserts all seven load. This is the test that would have caught the packaging break that prompted the consolidation.

AGPL-3.0.
