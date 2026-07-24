# pi-git

**Message-rewind that reverts files too** — a [Pi](https://pi.dev) extension that makes Pi's native `/fork` (rewinding to an earlier message) also roll the working tree back to how it was then. Pure harness behavior: **no agent tools, no commands to run** — it just works.

Part of the [`pi-*` suite](https://github.com/kazzarahw/pi-shared).

## What it does

- **Checkpoints the working tree at the start of every turn**, keyed to the user-message entry, stored as a commit under a private ref namespace (`refs/pi-git/checkpoints/<entryId>`) — captured with a temp index, so your real index and `HEAD` are untouched.
- **On Pi's fork lifecycle** (`session_before_fork` → `session_shutdown{reason:"fork"}`), restores the tree to the forked-to checkpoint. So when you rewind a message, the files change back with it — the agent isn't even aware.

Emits `git:checkpoint { ref, reason }` and `git:rollback { ref, reason }`.

## Configure

`/pi-git` opens a settings panel (or `/pi-git <off|notify|block>`). Persisted to `~/.pi/agent/pi-git.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `notify` | `off` disables checkpointing; `notify`/`block` both = checkpoint + restore-on-rewind (nothing to block, so they're equivalent) |
| `worktrees.auto` | `false` | give parallel [pi-spawn](https://github.com/kazzarahw/pi-spawn) jobs an isolated worktree *(integration deferred)* |
| `worktrees.baseDir` | `.pi/worktrees` | where worktrees are created |

Requires a git repository (checkpoints no-op outside one).

## Install

```sh
pi install git:github.com/kazzarahw/pi-git
```

AGPL-3.0.
