# pi Suite — House Style & Conventions

The shared design contract every `pi-*` extension follows. The goal is a small,
self-consistent, **agent-facing** extension suite that cooperates *natively* —
not seven independent extensions that happen to share a namespace.

**Audience:** you, when building each extension. **Roster (7):** `pi-consult`,
`pi-git`, `pi-lens` (absorbs verify), `pi-memory`, `pi-spawn`, `pi-todo`,
`pi-browser`. All are ground-up rewrites under `github.com/kazzarahw`, AGPL-3.0,
studying existing gallery packages as reference only (never pasting source).

---

## 1 · Interface model — who consumes each extension

This is the spine. Every capability is exposed through up to three surfaces, in
priority order. **Decide the surface by asking "who triggers this?"**

| Surface | Consumer | Mechanism | Use for |
|---|---|---|---|
| **Tools** | the **agent** (model) | `pi.registerTool` | the primary surface — every capability the model invokes |
| **Hooks** | the **harness** | `pi.on(...)` + `pi.events` | automatic behavior with nobody in the loop; where native cooperation lives |
| **Commands** | the **user** | `pi.registerCommand` | minimal — configuration and explicit human overrides only |

**Rule of thumb:** if the agent or the harness should trigger it, it is a tool or
a hook — *not* a command. The user isn't running `/consult`, `/spawn`, or
`/checkpoint`; those are agent tools and harness hooks. Commands exist only for
the human, and the human mostly just configures and walks away.

---

## 2 · Identity & packaging

- **GitHub:** `kazzarahw/pi-<name>`. **Package `name`:** `pi-<name>` (unscoped;
  not published to npm — installed via `pi install git:github.com/kazzarahw/pi-<name>`).
- **License:** AGPL-3.0. Reference behavior/docs/API of other packages; do not
  paste their source.
- **Runtime:** TypeScript, ESM, Bun. Pi core packages (`@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`) go in `peerDependencies: "*"` — never bundle them.
- **Repo skeleton (identical across all 7):**
  ```
  pi-<name>/
  ├── package.json     # pi manifest + "pi-package" keyword + peerDeps + pi-shared devDep
  ├── index.ts         # default export: (pi: ExtensionAPI) => { ... }
  ├── README.md
  └── LICENSE          # AGPL-3.0
  ```

---

## 3 · Tools (the agent surface)

- **Naming:** `<domain>_<verb>`, snake_case — `todo_write`, `memory_recall`,
  `memory_write`. A **bare verb** is allowed when an extension exposes exactly one
  tool: `consult`, `spawn`.
- **Dispatch tools (action enum over N tools):** when a domain exposes many
  variant actions over a shared target or session, expose **one** `<domain>` tool
  whose `action` is a `StringEnum`, not a tool per action — e.g.
  `browser({ action, … })` wrapping agent-browser's ~40 verbs, or
  `lens({ action, … })` for hover/references/definition/rename. Use shared,
  action-gated params, each described with which actions it applies to. Reach for
  this whenever a per-action design would mint more than ~3–4 near-identical
  tools; the goal is a tight agent surface, not one tool per capability.
- **Enums:** always `StringEnum` (from `@earendil-works/pi-ai`) — never
  `Type.Union([Type.Literal(...)])` (Google-provider compatibility).
- **Params:** typebox schemas, snake_case, **every param has a `description`**.
  Reuse canonical names across extensions: `path`, `query`, `model`, `cwd`,
  `id`, `content`.
- **Result shape:** `{ content: [{ type: "text", text }], details: { ... } }`.
  Put any state that must survive session forking in `details` (Pi reconstructs
  extension state from tool-result `details` on session events).
- **Abort:** thread `ctx.signal` into every async call (`fetch`, subprocess,
  model calls) so Esc cancels cleanly.

---

## 4 · Hooks & the cooperation layer (the harness surface)

Automatic behavior via `pi.on(...)`; cross-extension coordination via
`pi.events`. This is what makes the suite feel native.

**Event vocabulary** — namespaced `domain:event`, documented JSON payloads,
defined once in `pi-shared`:

| Event | Emitted by | Payload |
|---|---|---|
| `lens:clean` / `lens:issues` | pi-lens | `{ file, diagnostics[] }` |
| `verify:passed` / `verify:failed` | pi-lens | `{ cmd, failures[] }` |
| `git:checkpoint` / `git:rollback` | pi-git | `{ ref, reason }` |
| `todo:updated` / `todo:task-complete` | pi-todo | `{ todos[] }` / `{ task }` |
| `memory:wrote` / `memory:recalled` | pi-memory | `{ keys[] }` |
| `spawn:started` / `spawn:finished` | pi-spawn | `{ agent, summary? }` |
| `consult:answered` | pi-consult | `{ model, topic }` |

**Cooperation this enables — what's wired today vs. intended:**
- **Wired:** pi-memory records a gotcha on `verify:failed` (pi-lens → pi-memory; opt-in via `autoCapture`).
- **Wired:** pi-git hooks Pi's own **fork lifecycle** (`session_before_fork` → `session_shutdown{reason:"fork"}`) so a user message-rewind also reverts the files changed since — the harness surface at its purest: no tool, no command, the agent isn't even aware.
- **By internal state, not the bus:** pi-lens gates its verify pass on "an edit landed and parses cleanly" via its own `dirty`/`hasErrors` flags rather than a `lens:clean` event — same effect, no cross-extension coupling.
- **Intended but not wired:** pi-git checkpointing on `todo:task-complete` — pi-git instead checkpoints **every turn** (keyed to the user-message entry), which is strictly more robust; the event is available if a finer trigger is ever wanted.

**Hook hygiene:** keep handlers fast and idempotent; never block the loop on slow
work without honoring `ctx.signal`; reserve `{ block: true }` for the `"block"`
enforcement mode only (see §7).

---

## 5 · Commands (the user surface — minimal)

Only two legitimate kinds of command:

1. **Configuration:** `/pi-<name>` opens an interactive config (via `ctx.ui`),
   persisted to settings (§7). One per extension.
2. **Explicit human override** the agent should *not* do autonomously. Genuinely
   rare — prefer hooking a native Pi affordance over inventing a command. The
   suite currently ships **none**: rewinding a message rides Pi's built-in
   `/fork` (pi-git hooks its lifecycle) rather than a custom `/rollback`.

Core capabilities are never commands. If you're tempted to add `/checkpoint`,
`/rollback`, or `/recall`, stop — checkpointing and restore are pi-git *hooks*
(auto on turn / on fork), and recall is `memory_recall` (tool).

---

## 6 · Context-injection format

Extensions that inject context (pi-lens, pi-memory) wrap it in **`<pi-<name>>`**
tags so the agent recognizes the whole family as harness-injected:

```
<pi-lens>
lens · diagnostics after edit to src/foo.ts
  12:5  error  'x' is possibly undefined  (ts2532)
</pi-lens>
```

- First line is a short `source · why` header so the model knows it's harness
  output, not user text or file content.
- **Channel:** `pi.on("context")` for standing context (memory recall);
  `tool_result` augmentation for reactive post-edit feedback (lens/verify).
- Injections are **ephemeral** (not written to the session) unless they represent
  a durable fact.

---

## 7 · Configuration & the enforcement dial

- **Source of truth:** settings, under a per-extension key (`piLens`, `piGit`, …)
  — shareable and version-controllable.
- **Front-end:** the `/pi-<name>` command (§5) reads/writes those settings
  interactively. Settings file and command stay in sync.
- **Universal enforcement dial** — every automation-capable extension exposes the
  same three-level `mode` (type defined in `pi-shared`):

  | `mode` | Behavior |
  |---|---|
  | `"off"` | manual tools only; no automatic behavior |
  | `"notify"` *(default)* | auto-run + surface/inject feedback; **never blocks** |
  | `"block"` | additionally hard-`{ block: true }` the offending action on failure |

  Extensions may add domain-specific sub-flags, but the top-level `mode` is
  universal and means the same thing everywhere. Extensions with **no blockable
  action** support `off`/`notify` only and treat `block` as `notify` — pi-git
  (checkpointing is invisible and non-blocking; `off` disables it) and pi-memory
  (writes aren't gated). Document this collapse per extension.

---

## 8 · Status / UI

- Namespace every `ctx.ui.setStatus(id, …)` / `setWidget(id, …)` call with the
  short name (`"lens"`, `"git"`, `"todo"`).
- Transient progress → `setStatus` (footer). Standing state (todo list, verify
  status) → `setWidget`.
- One shared visual convention (e.g. colored state dots + `name: message`).
- `ctx.ui.notify` is reserved for genuinely user-actionable events; automatic
  behavior stays quiet in the footer/widget.

---

## 9 · Errors, logging, abort

- Tool errors: return structured text in `content` **and** set `details.error`;
  don't throw across the tool boundary.
- Log with a `[pi-<name>]` prefix.
- Every abort-aware async call takes `ctx.signal`.

---

## 10 · The `pi-shared` package

Types + constants only. Zero runtime, zero bundling cost (a `devDependency`;
types erase at compile time). Single source of truth for the cross-extension
contract, so mismatches are caught by the type-checker.

Contents:
- Event names + payload types (§4).
- The `mode` enum (§7).
- Injection-tag helpers/constants (§6).
- Shared param-name types where useful (§3).

This document lives here too — `pi-shared` is both the written contract and the
coded one.

---

## Appendix · Per-extension surface map

Seven tools across the suite — a deliberately tight agent surface. The rule that
keeps it small: automatic behavior is a **hook**, not a tool (pi-git); many
variant actions collapse behind one **`action` enum** tool (`browser`, `lens`);
and read paths are covered by tool-result echoes + context injection, not extra
read tools (pi-todo).

| Extension | Tools (agent) | Emits / subscribes · hooks (harness) | Commands (user) |
|---|---|---|---|
| **pi-consult** | `consult` | emits `consult:answered` | `/pi-consult` |
| **pi-git** | **none** | emits `git:*`; hooks: checkpoint each turn (keyed to the user-message entry), **restore on Pi's fork lifecycle**; worktree capability (pi-spawn integration deferred) | `/pi-git` |
| **pi-lens** | `lens` *(action enum)* | emits `lens:*`/`verify:*`; hooks: inject diagnostics (LSP + linters, multi-language toolchain) + opt-in auto-format on `tool_result`, **auto-verify on `agent_settled`** (no verify tool), prewarm servers on `session_start` | `/pi-lens` |
| **pi-memory** | `memory_recall`, `memory_write` | emits `memory:*`; subs `verify:failed` (auto-capture); hooks: inject the memory INDEX on `context` | `/pi-memory` |
| **pi-spawn** | `spawn` *(`tasks` list — 1 or many)* | emits `spawn:*` | `/pi-spawn` |
| **pi-todo** | `todo_write` | emits `todo:*`; hooks: widget + inject list on `session_start`/`session_compact` | `/pi-todo` |
| **pi-browser** | `browser` *(action enum — `search`/`read`/`open`/`snapshot`/…)* | — | `/pi-browser` |
