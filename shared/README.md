# `shared/` — the suite's internal library

Everything the extensions agree on. Read this to **write or replace an
extension**; the enforceable parts of it are pinned by `test/contract.test.ts` and
`test/boundaries.test.ts`, so this document describes the rules rather than being their
source of truth.

`shared/` is an **internal module**, imported by relative path — not a package and not a
dependency of any kind. Pi installs with `npm install --omit=dev`, so anything imported
at runtime from `devDependencies` is absent on a real install. This code was once a
separate `pi-shared` repo consumed as a devDependency, and every `pi install git:…`
failed with `Cannot find package 'pi-shared'`. Keeping it internal removes the failure
mode rather than working around it; `scripts/smoke-install.sh` guards it in CI.

`shared/` is a **leaf**: it never imports from an extension. Extensions never import from
each other. Both are enforced by `test/boundaries.test.ts`.

## Contents

| Module | Contents |
|---|---|
| `mode.ts` | the universal `off \| notify \| block` enforcement dial |
| `nudge.ts` | the settle-time nudge decision, and the no-progress guard for `block` |
| `events.ts` | the `domain:event` vocabulary and payload types |
| `surface.ts` | the agent-surface SSOT — one entry per extension |
| `tags.ts` | the `<pi-*>` context-injection format |
| `config.ts` | config path resolution, read/write, corrupt-file fallback |
| `fields.ts` | config field validators (`str`, `bool`, `posNum`, `int`, `oneOf`, …) |
| `settings-panel.ts` | the shared `/pi-<name>` settings panel |
| `exec.ts` | the subprocess runner — always resolves, never rejects |
| `cwd.ts` | `cwdOf(ctx)` — the only permitted way to resolve a working directory |
| `deadline.ts` | composes a timeout with the caller's abort signal, distinguishably |
| `truncate.ts` | agent-facing truncation, over Pi's own utilities |
| `frontmatter.ts` | `---`-delimited markdown frontmatter (memories, agent defs) |
| `hash.ts` | `stableHash` — short, stable, non-cryptographic string hash |
| `tool-input.ts` | `editedPath(input)` and the `EDIT_TOOLS` / `FILE_TOOLS` sets |
| `test/harness.ts` | a fake `ExtensionAPI` for testing extension wiring |

**Import rule.** Import from `shared/index.ts` for pure types and helpers. Import
`shared/exec.ts`, `shared/config.ts`, and `shared/settings-panel.ts` **directly** — they
are kept out of the barrel deliberately, because re-exporting them would pull their
heavier dependencies (notably `pi-tui`) into every importer.

## Interface model — who consumes each capability

The spine. Decide a surface by asking **"who triggers this?"**

| Surface | Consumer | Mechanism | Use for |
|---|---|---|---|
| **Tools** | the **agent** | `pi.registerTool` | the primary surface — every capability the model invokes |
| **Hooks** | the **harness** | `pi.on(...)` + `pi.events` | automatic behavior with nobody in the loop |
| **Commands** | the **user** | `pi.registerCommand` | configuration and explicit human overrides only |

If the agent or the harness should trigger it, it is a tool or a hook — *not* a command.
Nobody runs `/checkpoint`; checkpointing is a pi-git hook. Nobody runs `/recall`; that is
`memory_recall`. The suite ships exactly one command per extension, `/pi-<name>`, and it
configures.

## Tools

- **Naming:** `<domain>_<verb>`, snake_case — `todo_write`, `memory_recall`. A bare verb
  is allowed when an extension exposes exactly one tool: `consult`, `spawn`.
- **Dispatch tools:** when a domain has many variant actions over a shared target,
  expose **one** tool with an `action` enum rather than a tool per action — `browser`
  wraps ~40 agent-browser verbs, `lens` wraps hover/references/definition/rename. Reach
  for this whenever a per-action design would mint more than ~3–4 near-identical tools.
- **Enums:** always `StringEnum` (from `@earendil-works/pi-ai`), never
  `Type.Union([Type.Literal(...)])` — Google-provider compatibility.
- **Params:** typebox schemas, snake_case, **every param has a `description`**. Reuse
  canonical names across extensions: `path`, `query`, `model`, `cwd`, `id`, `content`.
- **Result shape:** `{ content: [{ type: "text", text }], details: { … } }`. State that
  must survive a session fork goes in `details` — Pi reconstructs extension state from
  tool-result `details`.
- **Truncate.** Agent-facing output goes through `truncateForAgent`. Pi's docs require
  it, and an untruncated linter run or subagent transcript enters the context whole.
- **Abort:** thread `ctx.signal` into every async call so Esc cancels cleanly. Where a
  deadline also applies, combine them with `deadline(ms, signal)` rather than threading
  two parameters — a tool that took both once honored neither.

## Errors

**Throwing is the mechanism, not a violation.** Pi sets `isError` on a tool result only
when `execute` throws, so a tool that cannot answer must throw rather than return prose
explaining that it could not. Handing the agent `"(none found)"` when a language server
never replied is worse than an error: it reads as a result. Prefix every message with
`[pi-<name>]`, and log with the same prefix.

The inverse applies to hooks: a hook must never break the turn it observes. Catch,
report through `ctx.ui.notify` when there is a UI and `console.error` otherwise, and let
the tool call proceed.

## Hooks and the cooperation layer

Automatic behavior via `pi.on(...)`; cross-extension coordination via `pi.events` — never
via an import. Event names are `domain:event` and their payloads are declared in
`events.ts`, so a mismatch between emitter and subscriber is a type error.

**Payloads must be self-contained.** A subscriber receives only `data` — no
`ExtensionContext`, so no `cwdOf`. Anything a handler needs belongs in the payload. This
is also what lets a subscriber work against *any* publisher of an event rather than only
the sibling that happens to ship today.

**Guard `ctx.hasUI` before injecting a message.** In one-shot print/JSON mode there is no
next prompt, so a queued message stalls Pi's exit waiting for one that never arrives.

Keep handlers fast and idempotent; honor `ctx.signal`; reserve `{ block: true }` for the
`"block"` enforcement mode.

## Context injection

Extensions that inject context wrap it in `<pi-<name>>` tags (`tags.ts`) so the agent
recognizes the whole family as harness-injected:

```
<pi-lens>
lens · diagnostics after edit to src/foo.ts
  12:5  error  'x' is possibly undefined  (ts2532)
</pi-lens>
```

The first line is a short `source · why` header so the model knows it is harness output,
not user text or file content. Use `pi.on("context")` for standing context and
`tool_result` augmentation for reactive post-edit feedback. Injections are ephemeral
unless they represent a durable fact.

## Configuration and the enforcement dial

Settings live under `<agentDir>/pi-<name>.json`; `agentDir()` honors
`PI_CODING_AGENT_DIR` and is the **only** way to resolve it. Each extension exports a
`ConfigSpec` — `name`, `defaults`, and its own `parse` — and gets read/write/fallback
from `config.ts`. Validation stays per-extension because the shapes genuinely differ;
build `parse` from the `fields.ts` validators, and construct the result field by field,
never by spreading raw JSON, so a key the spec no longer knows is dropped rather than
carried through.

Every automation-capable extension exposes the same three-level `mode`:

| `mode` | Behavior |
|---|---|
| `"off"` | manual tools only; no automatic behavior |
| `"notify"` *(default)* | auto-run + surface/inject feedback; **never blocks** |
| `"block"` | additionally hard-`{ block: true }` the offending action on failure |

Extensions may add sub-flags, but the top-level `mode` means the same thing everywhere.
Those with no blockable action support `off`/`notify` only and treat `block` as `notify`
— pi-git (checkpointing is invisible) and pi-memory (writes aren't gated). Document the
collapse in that extension's README.

## Status and UI

Namespace every `ctx.ui.setStatus(id, …)` / `setWidget(id, …)` call with the extension's
short name. Transient progress → `setStatus` (footer). Standing state → `setWidget`.
`ctx.ui.notify` is for genuinely user-actionable events; automatic behavior stays quiet.

Any custom `ctx.ui.custom` component **must** truncate every rendered line to the `width`
argument. Rendering wider than the terminal crashes Pi outright with
`Rendered line N exceeds terminal width`.

## Writing a new extension

Extensions are peers. Any one can be disabled, replaced, or prototyped against without
touching the others — the only coupling permitted is this library and the event bus.

1. `mkdir <name>/` with `index.ts`, `src/`, `test/`, and a `README.md` carrying the
   standard sections (*What it does* / *Tool(s)* / *Configure* / *Install*).
2. `index.ts` default-exports `(pi: ExtensionAPI) => void`. It wires only — registration,
   hooks, and guards. Logic lives in `src/` behind injected dependencies so it is
   testable without Pi.
3. Add an entry to `SURFACE` in `surface.ts`; `package.json`'s `pi.extensions` is checked
   against it.
4. Every module under `src/` must be reachable from `index.ts`. Unreachable code fails
   `test/boundaries.test.ts` — a capability nothing calls is not deferred, it is dead.
5. Write a `test/wiring.test.ts` using `shared/test/harness.ts`. This layer had no
   coverage in the original seven repos and is where several defects lived.
