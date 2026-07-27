# pi-git

**Undo and redo for your files, following the conversation** — a [Pi](https://pi.dev) extension that makes moving through the session tree move the working tree with it. Pure harness behavior: **no agent tools, no commands to run** — it just works.

Part of the [pi-suite](../README.md).

## What it does

- **Records a file's state before `write` or `edit` touches it** (on `tool_call`, the one moment the pre-edit bytes are still on disk). That is what lets a rewind delete a file the agent created rather than guess.
- **Records the whole working set before `bash` runs** — a shell command names no path, so there is nothing to record after the fact. See [Shell commands](#shell-commands).
- **Checkpoints at the start of every turn**, keyed to the user-message entry — the state that message was sent in.
- **Checkpoints again whenever you navigate**, keyed to the leaf you are leaving — the state you would want back if you navigate forward again.
- **Restores on `/tree` navigation, in both directions**, and on Pi's fork lifecycle (`session_before_fork` → `session_shutdown{reason:"fork"}`).
- **Says what it did.** A restore reports how many files it wrote and removed, and warns when `HEAD` moved — see [Commits](#commits-the-half-it-cannot-undo).

Emits `git:checkpoint { entryId, reason, files }` and `git:rollback { entryId, reason, written, removed }`.

## Where it stores things, and why not in git

Content is stored under `~/.pi/agent/checkpoints/`: one manifest per session entry, file content de-duplicated by SHA-256 in a shared blob directory. **Nothing is written into your project, and no git object, ref, or index is ever touched.**

This used to work through git plumbing — `git add -A` into a temporary index, `write-tree`, `commit-tree`. That has a work-tree boundary, and a session rooted *above* a repository falls off it: `add -A` records the inner repository as a gitlink and captures none of its contents, so a restore reverted the outer file, left the inner one edited, and reported success. Manifest keys are absolute paths; a path has no root, so it has no boundary.

A session Pi never writes to disk gets no checkpoints at all. `/tree`, `/fork`, and
`--resume` all work from the session file, so a checkpoint taken in a `--no-session` run
is unreachable the moment it ends — and pi-spawn runs every subagent as
`pi --mode json -p --no-session`, so each one was building a full store for a session
nobody could navigate. The parent process still guards the delegation, which is where the
coverage that matters comes from.

Git still has a job, read-only: `git status` enumerates what changed and `git ls-files` what could, which is how the guards below cover files no tool call ever named. Outside a repository those sources simply contribute nothing and the tool-tracked files still work.

## Configure

`/pi-git` opens a settings panel (or `/pi-git <off|notify|block>`). Persisted to `~/.pi/agent/pi-git.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `notify` | `off` disables checkpointing; `notify`/`block` both = checkpoint + restore (nothing to block, so they're equivalent) |
| `detectDirty` | `true` | also checkpoint what `git status` reports at checkpoint time |
| `guardOpaqueWrites` | `true` | record the working set before a `bash` command runs — see below |
| `guardDelegated` | `true` | record the working set before a delegated subagent runs — see below |
| `checkpointTtlDays` | `30` | how long a session's checkpoints survive; swept on session start — the panel reads it as `30 days` |
| `maxFileBytes` | `10485760` | files larger than this are reported and left out rather than stored — the panel reads and writes it as `10 MB`; the stored value stays bytes |
| `maxGuardedFiles` | `5000` | cap on either guard's working set; overflow is reported, never silently dropped (JSON file only) |

Does **not** require a git repository.

## Shell commands

`bash` reaches the `tool_call` hook, but its input is an opaque command string — a
`sed -i`, a heredoc, a `git apply`, a plain `>` redirect. Nothing in it says which files
are about to change, so there is no path to record.

`detectDirty` does not close that gap, and used to be documented as though it did. It runs
at *checkpoint* time, which is always after the fact: by then the modified bytes are the
only ones left to see, and they get stored as the file's origin. A rewind then restored
the file to the state it was being rewound *from* — and reported success. Shell edits were
the one class of change pi-git silently could not undo.

So a `bash` call is treated like a delegation: before the command runs, pi-git records the
working set — `git ls-files` plus whatever is already dirty. Unlike the delegation guard
this is **awaited**, because the command runs the moment the hook returns; a detached
guard would lose the race and record the post-command bytes, which is the bug rather than
the fix. The first such call in a session pays for one tracked-tree hash; later ones are
near-free, since the store is content-addressed and an origin is never rewritten.

Outside a repository there is no working set to enumerate, so the guard contributes
nothing and edits made through a tool are still covered.

## Commits: the half it cannot undo

pi-git restores **files**. It never moves a ref, and that is deliberate — a branch it does
not own is not its business. But an agent that commits mid-session leaves the two halves
disagreeing: the bytes go back to the checkpoint, `HEAD` stays at the agent's last commit,
and `git status` then reports a working tree that reverts its own history.

That reads, reasonably, as *"the rewind did nothing"* — the commits are all still in
`git log` and the files all look modified — when in fact it did exactly what it promised.

So each checkpoint records the repository's `HEAD` alongside the files, and a restore
compares. When it moved, pi-git says so and names both commits, along with the two ways
out (`git reset --hard <was>` to drop them, `git checkout -- .` to keep them and discard
the restore). Only the repository at the session's own root is recorded; a commit in a
*nested* repository is not seen, so the warning stays silent about it — silence is never a
claim that nothing moved, only that this did not observe it.

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
