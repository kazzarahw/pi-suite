# pi-lens

**Real-time code feedback** — a [Pi](https://pi.dev) extension that injects LSP + linter diagnostics after the agent reads or edits a file, runs an automatic test/verify pass, optionally auto-formats, and exposes one `lens` tool for precise code navigation. Multi-language, with each tool using its own defaults and honoring the project's config.

Part of the [pi-suite](../README.md).

## What it does

- **Diagnostics on read/edit** — after a `read`/`write`/`edit`, gathers the file's LSP diagnostics plus linter output, merges them, and injects a `<pi-lens>` block (or stays silent when clean). A one-line count goes to the status footer, so you can see it happen.
- **Standing context** — one short block on every call telling the agent that diagnostics arrive on their own, that silence means clean, and what the verify command is. Without it the agent has no way to know pi-lens exists, and re-runs the type-checker by hand after every edit.
- **Auto-verify on settle** — once edits land and parse cleanly, runs the project's test/build command (autodetected: `bun test` / `npm test` / `pytest`) and reports pass/fail — to **you** the moment it finishes, and to the agent. Emits `verify:passed` / `verify:failed` (the latter feeds [memory](../memory)).
- **Opt-in auto-format** — on write/edit, run the language's formatter in place, re-sync the LSP, and note the reformat. Off by default.
- **Prewarm** — start the language servers on session start (incl. after `/fork`) so the first read is fast.
- **`lens` tool** — `hover` / `references` / `definition` / `rename` at a position, via a hand-rolled minimal LSP client (more precise than grep).

Emits `lens:clean` / `lens:issues` and `verify:passed` / `verify:failed`.

Nothing here requires another extension, and nothing requires this one. [pi-memory](../memory) *optionally* listens for `verify:failed` to capture a gotcha; if it is absent the events go nowhere, and if pi-lens is absent pi-memory just never hears one. The coupling is the bus, never an import.

## Toolchain

A per-language registry (`ext → { lsp?, linters[], formatter? }`); tools run only when installed (`/pi-lens` shows a health line), and each auto-layers the project's own config.

| Language | LSP | Linter | Formatter |
|---|---|---|---|
| TS/JS | typescript-language-server | eslint *(when configured)* | prettier |
| Python | pyright | ruff | ruff format |
| Rust · Go | rust-analyzer · gopls | — | rustfmt · gofmt |
| Shell | bash-language-server | shellcheck | shfmt |
| JSON/YAML/TOML/MD | schema servers | — | prettier / taplo |

## Tool

```
lens({ action: "hover" | "references" | "definition" | "rename", path, line, col, new_name? })
```

## Configure

`/pi-lens` opens a settings panel (or `mode <m>` / `verify <cmd>` / `autoformat on|off` / `prewarm on|off`). Persisted to `~/.pi/agent/pi-lens.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `notify` | `off` = manual `lens` tool only; `notify` = inject diagnostics + auto-verify; `block` = also auto-continue the agent on a failed verify |
| `verifyCmd` | *(autodetect)* | test/build command |
| `autoFormat` | `false` | format on write/edit |
| `prewarm` | `true` | warm the LSP on session start |

`block` is the **Insist** shape, not Interdict, and that is forced rather than chosen:
only `tool_call` can refuse an action, and it fires *before* the write, when the
diagnostics worth refusing over do not exist yet. What pi-lens finds at settle is
unfinished work, so it insists — bounded by the same no-progress guard pi-todo and
pi-goal use, since the agent that broke the build may never fix it.

Both `notify` and `block` tell **you** the verify result immediately via a notification;
they differ only in whether the agent is made to act on a failure now or on your next
message. A passing verify is never sent to the agent at all — spending a turn to report
that nothing happened is how a useful signal becomes noise.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

Language servers, linters, and formatters are discovered on `PATH` (install what you use). AGPL-3.0.
