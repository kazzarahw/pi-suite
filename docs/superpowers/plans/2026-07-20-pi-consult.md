# pi-consult — Build Spec

> A design/implementation spec, not a code dump. It fixes the decisions, file
> responsibilities, exact interfaces, build order, and acceptance criteria. The
> implementing agent writes the code against the contracts below — no function
> bodies are pre-written here on purpose.

**Goal:** A Pi extension exposing a `consult` tool that shells out to the `claude` CLI for a read-only second opinion and returns the advice as text.

**Architecture:** Pure, unit-testable core (subprocess runner + config I/O) behind thin Pi glue (tool + command + factory). No lifecycle hooks, no file mutation, no context injection — purely agent-invoked, so it is exempt from the house-style enforcement dial.

**Tech Stack:** TypeScript (ESM), Bun + `bun test`, `typebox` params, `node:child_process` for the subprocess, `@earendil-works/pi-*` types as peer deps.

## Global Constraints (from `pi-shared/HOUSE-STYLE.md`)

- AGPL-3.0; reference behavior, never paste source.
- ESM/TS/Bun; Pi core packages + `typebox` in `peerDependencies: "*"`, never bundled.
- Package name `pi-consult` (unscoped, unpublished). Entry `index.ts`, default export `(pi: ExtensionAPI) => void`.
- Tool naming: bare verb `consult`. `StringEnum` for *closed* enums only.
- Result shape `{ content: [{ type: "text", text }], details }`; errors by `throw`.
- Emits `consult:answered` → `{ model: string, topic: string }`.
- User surface: one config command `/pi-consult`. No user-facing action command.
- Honor `ctx.signal`; log prefix `[pi-consult]`.

## Design Decisions

1. **Subprocess, not model runtime.** Invoke `claude -p <prompt> --model <model>` (`-p` = print/non-interactive; `--prompt` is not a real flag). Use `node:child_process.execFile` with an **injectable `run` function** so tests never spawn a real process.
2. **Blocking return + status spinner.** `execute` awaits the full response and returns it as tool text; shows `ctx.ui.setStatus("consult", …)` while waiting. No TUI streaming in v1.
3. **Config = JSON file** at `~/.pi/agent/pi-consult.json` (`{ defaultModel, allowedModels }`), read per call, edited via `/pi-consult`.
4. **`model` param is optional & free-form** (`Type.Optional(Type.String())`, *not* a `StringEnum`) — the set of claude aliases is open and user-defined. Omitted → `defaultModel`.
5. **`ctx.ui` is call-time only.** It exists inside `execute`/`handler`, never at factory time — the tool/command read it from their own `ctx` argument, not from injected deps.

### Open item for the human
- The default model alias (`DEFAULTS.defaultModel`). Placeholder: `"opus"`.

## File Structure & Responsibilities

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json` | scaffold; peer deps; `bun test` / `typecheck` scripts |
| `src/config.ts` | `ConsultConfig` type, `DEFAULTS`, `configPath`, `loadConfig`, `saveConfig` |
| `src/consult.ts` | `runConsult` — spawns claude, returns trimmed stdout, throws on failure |
| `src/tool.ts` | `buildConsultTool(deps)` → tool definition (reads `ctx.ui` at call time) |
| `src/command.ts` | `buildConsultCommand(deps)` → `/pi-consult` name + options |
| `index.ts` | factory: construct deps from `pi`, register tool + command |
| `test/*.test.ts` | unit tests for the pure core + tool/command with fakes |

## Interfaces / Contracts

These are the seams — pin them exactly; everything else is implementation detail.

```typescript
// config.ts
interface ConsultConfig { defaultModel: string; allowedModels: string[]; }
const DEFAULTS: ConsultConfig;                       // defaultModel: "opus" (see open item)
function configPath(): string;                        // ~/.pi/agent/pi-consult.json
function loadConfig(path?: string): ConsultConfig;    // missing/invalid file -> DEFAULTS
function saveConfig(cfg: ConsultConfig, path?: string): void;

// consult.ts
type RunFn = (cmd: string, args: string[], opts: { signal?: AbortSignal })
  => Promise<{ stdout: string; stderr: string; code: number }>;
interface RunConsultOptions { model: string; prompt: string; signal?: AbortSignal; run?: RunFn; }
function runConsult(opts: RunConsultOptions): Promise<string>;   // args: ["-p", prompt, "--model", model]

// tool.ts — deps carry no ui; the tool reads ctx.ui inside execute
interface ToolDeps {
  loadConfig: () => ConsultConfig;
  runConsult: (o: { model: string; prompt: string; signal?: AbortSignal }) => Promise<string>;
  emit: (event: string, data: unknown) => void;
}
function buildConsultTool(deps: ToolDeps): unknown;   // shape passed to pi.registerTool
// params: { prompt: string; model?: string }
// on success: emit("consult:answered", { model, topic: prompt.slice(0,80) });
//             return { content: [{type:"text", text: advice}], details: { model } }

// command.ts — reads ctx.ui.notify inside the handler
interface CommandDeps { loadConfig: () => ConsultConfig; saveConfig: (c: ConsultConfig) => void; }
function buildConsultCommand(deps: CommandDeps): { name: "pi-consult"; options: { description: string; argumentHint: "[model]"; handler: (args: string, ctx: unknown) => Promise<void> } };
// no arg -> notify current defaultModel; "<model>" -> save {…cfg, defaultModel: model} + notify
```

## Build Sequence

Each step is independently testable and ends in a commit. TDD: write the listed
assertions first, then implement to green.

- [ ] **1 · Scaffold** — `package.json` (name, `type:module`, peer+dev deps, `pi` manifest, `pi-package` keyword), `tsconfig.json` (strict, bundler resolution, `types:["bun"]`), stub `index.ts` + `src/*` so imports resolve. Accept: `bun install && bun test` runs (0 tests OK).
- [ ] **2 · `runConsult`** — Accept: (a) forwards `["-p", prompt, "--model", model]` and returns *trimmed* stdout; (b) throws with stderr text when `code !== 0`. Tests inject a fake `run`; never spawn claude.
- [ ] **3 · Config I/O** — Accept: (a) missing file → `DEFAULTS`; (b) `saveConfig`→`loadConfig` round-trips; tests use a tmp path.
- [ ] **4 · `consult` tool** — Accept: (a) returns claude advice as tool text and emits `consult:answered`; (b) `params.model` overrides `defaultModel`. Tests pass a fake `ctx` `{ ui: { setStatus() {} } }` and fake deps.
- [ ] **5 · `/pi-consult` command** — Accept: `handler("sonnet", fakeCtx)` calls `saveConfig` with `defaultModel: "sonnet"`. Fake ctx `{ ui: { notify() {} } }`.
- [ ] **6 · Factory wiring** — `index.ts` builds deps from `pi` (`loadConfig`, `runConsult`, `emit: pi.events.emit`), `pi.registerTool(buildConsultTool(...))`, `pi.registerCommand(name, options)`. Accept: `bun run typecheck && bun test` clean; manual smoke `pi -e ./index.ts` → agent calls consult, advice returns (needs `claude` on PATH), `/pi-consult sonnet` updates default.

## Test Strategy

- **Pure core** (`consult`, `config`): full unit coverage via injected `run` / tmp files — the bulk of the tests, zero Pi runtime.
- **Glue** (`tool`, `command`): construct with fake deps + fake `ctx`; assert on returned content, emitted events, and `saveConfig` calls.
- **Manual smoke** only for the real `claude` subprocess (can't unit-test the binary).

## Risks / Notes

- `ctx.ui` availability inside tool `execute` is assumed; guard with optional chaining so a missing `ui` degrades to no spinner rather than throwing.
- Exact `claude` print-mode flags (`-p`, `--model`) — verify against the installed `claude` version during step 6 smoke test.
- v1 blocks on the full response (no streaming); revisit only if latency is annoying.
