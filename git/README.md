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
| `guardDelegated` | `true` | record the working set before a delegated subagent runs — see below |
| `checkpointTtlDays` | `30` | how long a session's checkpoints survive; swept on session start |
| `maxFileBytes` | `10485760` | files larger than this are reported and left out rather than stored |
| `maxGuardedFiles` | `5000` | cap on the delegation guard's working set; overflow is reported, never silently dropped (JSON file only) |

Does **not** require a git repository.

## Delegated edits

pi-git learns a file's pre-edit bytes from the `tool_call` hook, which fires in *this*
process. A subagent edits from its own `pi` process, so those writes are invisible here:
a file that was clean when the delegation started had no recorded origin, was in no
manifest, and survived a rewind untouched while pi-git reported success. The least
supervised edits in the suite were the only ones it could not undo.

So pi-git subscribes to `spawn:started` and records the repository's working set —
`git ls-files` plus whatever is already dirty — *before* the subagent runs. It cannot
know which files will be touched, so it covers the ones that can be. That is affordable
only because the store is content-addressed: a file checkpointed unchanged is one blob,
shared across every entry and session that references it. The first guarded delegation in
a session pays for the tree; later ones are near-free, since `rememberOrigin` never
rewrites an origin it already holds.

Subscribed, not imported. It holds against *any* publisher of `spawn:started`, and with
nothing publishing it the handler never runs — [`pi-spawn`](../spawn) stays independently
disable-able, and pi-git keeps working with it gone. Outside a git repository there is no
working set to enumerate, so the guard contributes nothing and the ordinary hooks still
cover every edit made through a tool.

## `/tree` labels

An entry pi-git checkpoints is labelled `⏱ files`, so the `/tree` picker shows which
points will actually put your files back *before* you navigate to one. Without it pi-git
could only answer afterwards, by reporting that it had no checkpoint for the point you
had already jumped to. A label you set yourself is never overwritten — those are your
bookmarks, and the checkpoint still restores either way.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
