# pi-git

**Undo and redo for your files, following the conversation** — a [Pi](https://pi.dev) extension that makes moving through the session tree move the working tree with it. Pure harness behavior: **no agent tools, no commands to run** — it just works.

Part of the [pi-suite](../README.md).

## What it does

- **Records a file's state before `write` or `edit` touches it** (on `tool_call`, the one moment the pre-edit bytes are still on disk). That is what lets a rewind delete a file the agent created rather than guess.
- **Checkpoints at the start of every turn**, keyed to the user-message entry — the state that message was sent in.
- **Checkpoints again whenever you navigate**, keyed to the leaf you are leaving — the state you would want back if you navigate forward again.
- **Restores on `/tree` navigation, in both directions**, and on Pi's fork lifecycle (`session_before_fork` → `session_shutdown{reason:"fork"}`).

Emits `git:checkpoint { entryId, reason, files }` and `git:rollback { entryId, reason, written, removed }`.

## Where it stores things, and why not in git

Content is stored under `~/.pi/agent/checkpoints/`: one manifest per session entry, file content de-duplicated by SHA-256 in a shared blob directory. **Nothing is written into your project, and no git object, ref, or index is ever touched.**

This used to work through git plumbing — `git add -A` into a temporary index, `write-tree`, `commit-tree`. That has a work-tree boundary, and a session rooted *above* a repository falls off it: `add -A` records the inner repository as a gitlink and captures none of its contents, so a restore reverted the outer file, left the inner one edited, and reported success. Manifest keys are absolute paths; a path has no root, so it has no boundary.

Git still has a job, read-only: `git status` tells pi-git which files changed, so a file that `bash` wrote — never passing through a tool call — is checkpointed too. Outside a repository that source simply contributes nothing and the tool-tracked files still work.

## Configure

`/pi-git` opens a settings panel (or `/pi-git <off|notify|block>`). Persisted to `~/.pi/agent/pi-git.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `notify` | `off` disables checkpointing; `notify`/`block` both = checkpoint + restore (nothing to block, so they're equivalent) |
| `detectDirty` | `true` | also checkpoint what `git status` reports, catching changes made by `bash` |
| `checkpointTtlDays` | `30` | how long a session's checkpoints survive; swept on session start |
| `maxFileBytes` | `10485760` | files larger than this are reported and left out rather than stored |
| `worktrees.auto` | `false` | give parallel [spawn](../spawn) jobs an isolated worktree *(integration deferred)* |
| `worktrees.baseDir` | `.pi/worktrees` | where worktrees are created |

Does **not** require a git repository.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
