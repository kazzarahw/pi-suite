# pi-plan

The **agent's plan** for [Pi](https://pi.dev) — an objective, a flat list of open work, and a
strict lifecycle over it, kept in the agent's context and enforced at the moment it edits.

Part of the [pi-suite](../README.md). Replaces `pi-todo` and `pi-goal`, which were two
halves of one thing.

## What it does

A task list written once, from maximum ignorance, and then treated as a contract rather
than a hypothesis is the failure this extension exists to fix. Items get marked done that
aren't. Discovered work appears silently mid-list. Work that turned out to be unnecessary is
either marked `done` — a lie — or left `pending` forever, and the list fills with noise
either way.

So the **lifecycle is the primary abstraction**, and every transition costs something:

- **Entering** work costs an *approach*. Supplying it is the decompose-before-you-commit
  step. `pi-todo` let the agent declare an item `in_progress` for free, so it did, before it
  had thought about how.
- **Finishing** costs a *note* saying what the outcome was.
- **Abandoning** costs a *reason*, and leaves a record. This is the exit `pi-todo` did not
  have.
- **Exactly one item is active at a time.** This is the single rule that separates a
  workflow from a wishlist.

The structure follows from that rather than driving it. There is no tree: a flat list of
**open items**, a disposable **worksheet** on whichever one is active, and an append-only
**log** of what was resolved and how. The worksheet is scaffolding — once an item is done
nobody cares about its five steps — so it collapses into the log entry. A step that turns
out to matter is *promoted* to a real item, and that promotion is itself a signal that the
work was bigger than the agent thought.

Two consequences of the flat shape make it cheaper than a tree: the open list stays small
enough to keep full-replace (familiar to the model, no id bookkeeping), and since only one
item is ever active, the operations acting on it need no id at all.

## Tool

```
plan({ action, … })
```

| action | params | |
|---|---|---|
| `objective` | `objective`, `criteria?`, `status?` | the north star |
| `items` | `items: [{content, id?}]` | replace the open list |
| `start` | `id`, `approach`, `steps?` | activate one item — the decompose step |
| `step` | `index`+`done` \| `steps` | tick, untick, or extend the worksheet |
| `promote` | `index` | a step turned out to be a real item |
| `finish` | `note` | resolve the active item as done |
| `drop` | `id`, `reason` | abandon an open item |

`items` sends the **complete open list** and replaces the previous one. Resolved work is not
in it. Ids are preserved by explicit id or by content match, which is what carries an item's
status, approach, and worksheet across a rewrite — and **the active item may not be
omitted**: it is finished or dropped explicitly, never dropped silently.

`start` and `drop` take an `id` because they name an item. `step`, `promote`, and `finish`
take none, because there is only ever one active item.

Restating the *same* objective carries omitted fields forward, so marking it met need not
repeat the criteria, and amending the criteria cannot silently reopen one already met.
Reopening is still possible — it just has to be said, with an explicit `status: "active"`.

Emits `plan:objective`, `plan:met` (once, on the transition), `plan:updated`,
`plan:item-done`, and `plan:item-dropped`.

## Where each piece of state goes

The split is load-bearing, not cosmetic. The standing block is prepended to every LLM call,
so it sits at message index 0, while the provider puts the conversation-history cache
breakpoint on the *last* user message — a cache hit needs the whole prefix to match.
Anything in there that moves as the work moves invalidates the entire conversation cache on
every call, in exactly the long sessions this extension is for.

| State | Where | Why |
|---|---|---|
| objective, criteria, active item + approach | **standing injection**, every call | changes when the agent *advances*, a few times a session |
| open list, worksheet ticks, counts | **widget** and the tool-result echo | free, always current, lands exactly when it changes |
| the log | **re-injected on session start / after compaction** | see below |

The log is the one that needs saying. A `finish`/`drop` result echoes the entry at the
moment it is written, but that echo lives in the transcript and dies at compaction — which
is precisely when the agent forgets it already abandoned something and proposes it again. So
compaction replays it, dropped entries first and always: *we tried this, here is why we
stopped* is the expensive thing to relearn.

## Automatic behavior (hooks)

- **Context injection** on `context` — the objective and the active item ride along on every
  call. A met objective stops being injected.
- **Restore + widget + log replay** on `session_start` / `session_compact`. Restore
  re-establishes every invariant, since this is the one place pi-plan reads state it did not
  construct: at most one active item, an active item always has an approach, and `seq` is
  raised past every id in use so a restored id is never reused.
- **Edit gate** on `tool_call`, in `block` mode only — see below.
- **Settle nudge** on `agent_settled`, per `mode`. Guarded on `hasUI`, so it never stalls
  `pi -p`.

## Configure

`/pi-plan` opens a settings panel (or `/pi-plan <off|notify|block>`). Persisted to
`~/.pi/agent/pi-plan.json`:

| `mode` | Behavior |
|---|---|
| `off` | tool and widget only — no injection, no nudge, no gate |
| `notify` *(default)* | inject the plan every call, plus a passive reminder on the next turn |
| `block` | auto-continue the turn while work is outstanding, **and** refuse `write`/`edit` calls made with nothing active (see the scope limit below) |

| Setting | Default | |
|---|---|---|
| `nudges` | `2` | How many times pi-plan may nudge about **one** objective. A quota per objective, not a no-progress detector: an objective is a declaration that changes only when the agent restates it, so there is nothing there that progress-tracking could honestly measure. Item-level nudges use no-progress detection instead, because item state *is* the work product. |
| `blocks` | `3` | How many consecutive edits `block` may refuse before giving up and letting one through with a notice. |

### `block` does both things, deliberately

`shared/mode.ts` describes two shapes for `block`: **Interdict** (return `{ block: true }`,
the action does not happen) and **Insist** (trigger another turn, because the complaint *is*
that nothing happened). pi-plan is the first extension in the suite that does both, and the
Interdict row was empty before it.

The two are decided by what an extension is looking at, not by which box it belongs in.
pi-plan interdicts an edit made with nothing active — a *precondition*, knowable exactly
when `tool_call` fires — and insists at settle when the plan has stalled, an *inaction*
knowable only afterwards. pi-lens can only insist: the diagnostics it would interdict do not
exist until after the write it would have to refuse.

One dial rather than two, because they are one intent: at `block`, the user is saying the
plan is binding. Splitting them would offer a combination nobody wants and make the dial
mean something different here than everywhere else in the suite.

**The gate only fires when a plan exists** — an objective, or at least one item. An empty
plan is not a violated plan; it is someone who has not started one, so installing pi-plan
never turns a one-line session into ceremony. And it is bounded by `blocks`, because an
agent that cannot work out what the gate wants would otherwise be unable to edit anything
for the rest of the session.

### What the gate does not cover

It gates `write` and `edit` — the `EDIT_TOOLS` set from `shared/tool-input.ts`. **A write
through `bash` is out of scope**: a `sed -i`, a heredoc, a `git apply`, or a plain `>`
redirect changes a file without naming it in the tool input, and the gate never fires. That
is the same blind spot `shared/tool-input.ts` calls `OPAQUE_WRITE_TOOLS`, and the reason
pi-git snapshots the whole working set before bash runs instead of reading a path out of it.

This is a scope decision, not an omission. Gating bash would mean either refusing it
wholesale — unusable, since bash is also the reads, the tests, and the git — or guessing
from the command string whether it writes, which fails open on exactly the shapes that
matter.

So `block` is a **discipline aid rather than an enforcement guarantee**. It makes editing
outside the plan take a deliberate detour; it does not make it impossible. If you need the
harder version, Pi's own permission system is the layer that can actually enforce it.

`/pi-plan clear` forgets the objective and the open list, and **keeps the log** — `clear`
means *the plan was wrong, re-plan*, and what was already tried and abandoned is exactly
what should carry into the re-plan. It disarms the gate, so it doubles as the escape hatch
from `block` mode. `/pi-plan reset` forgets everything, log included.

Setting the objective is deliberately **not** a command — that is the agent's job via
`plan`, and `/pi-plan` configures.

## Optional enhancement

If [`pi-lens`](../lens) — or anything else publishing `verify:passed` — is running, a green
run adds `verify ✓` to the widget, and the settle reminder names the command that passed and
asks whether it satisfies the criteria. `criteria` is literally *how you will know the
objective is met*, and a passing test run is the strongest evidence available for that.

It never marks anything met: whether passing checks satisfy *this* objective is a judgement
about intent, and it stays the agent's to make. It also never reaches either nudge guard — a
peer that could refill a quota would mean installing pi-lens silently changed whether
pi-plan's `block` mode terminates. There is no import in either direction, only the bus, and
with no publisher the fragment simply never appears.

## Install

```sh
pi install git:github.com/kazzarahw/pi-suite
```

AGPL-3.0.
