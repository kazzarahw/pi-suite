# pi-lens

**Real-time code feedback** — a [Pi](https://pi.dev) extension that injects LSP + linter diagnostics after the agent reads or edits a file, runs an automatic test/verify pass, optionally auto-formats, and exposes one `lens` tool for precise code navigation. Multi-language, with each tool using its own defaults and honoring the project's config.

Part of the [`pi-*` suite](https://github.com/kazzarahw/pi-shared).

## What it does

- **Diagnostics on read/edit** — after a `read`/`write`/`edit`, gathers the file's LSP diagnostics plus linter output, merges them, and injects a `<pi-lens>` block (or stays silent when clean).
- **Auto-verify on settle** — once edits land and parse cleanly, runs the project's test/build command (autodetected: `bun test` / `npm test` / `pytest`) and reports pass/fail. Emits `verify:passed` / `verify:failed` (the latter feeds [pi-memory](https://github.com/kazzarahw/pi-memory)).
- **Opt-in auto-format** — on write/edit, run the language's formatter in place, re-sync the LSP, and note the reformat. Off by default.
- **Prewarm** — start the language servers on session start (incl. after `/fork`) so the first read is fast.
- **`lens` tool** — `hover` / `references` / `definition` / `rename` at a position, via a hand-rolled minimal LSP client (more precise than grep).

Emits `lens:clean` / `lens:issues` and `verify:passed` / `verify:failed`.

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
| `mode` | `notify` | `off` = manual `lens` tool only; `notify` = inject diagnostics + auto-verify |
| `verifyCmd` | *(autodetect)* | test/build command |
| `autoFormat` | `false` | format on write/edit |
| `prewarm` | `true` | warm the LSP on session start |

## Install

```sh
pi install git:github.com/kazzarahw/pi-lens
```

Language servers, linters, and formatters are discovered on `PATH` (install what you use). AGPL-3.0.
