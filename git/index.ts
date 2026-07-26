import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cwdOf, EDIT_TOOLS, editedPath } from "../shared/index.ts";
import { defaultExec } from "../shared/exec.ts";
import { loadConfig, saveConfig, type GitConfig } from "./src/config.ts";
import type { CheckpointStore } from "./src/store.ts";
import { createGitSession } from "./src/session.ts";
import { dirtyPaths, trackedPaths } from "./src/detect.ts";
import {
  currentLeafId,
  currentUserEntryId,
  resolveRestoreTarget,
  type SessionManagerLike,
} from "./src/checkpoints.ts";
import {
  checkpointTurn,
  guardDelegation,
  restoreEntry,
  restoreOnForkShutdown,
  type PendingFork,
} from "./src/hooks.ts";
import { buildGitCommand } from "./src/command.ts";

/**
 * The `/tree` label put on an entry pi-git can restore.
 *
 * Labels persist in the session and render in the `/tree` picker, so this turns the
 * question a user actually has at that picker — *which of these points will put my
 * files back?* — into something visible before they commit to navigating. Without it
 * pi-git could only answer afterwards, by reporting that it had no checkpoint for the
 * point already jumped to.
 *
 * A leading marker rather than prose: the picker is a dense list, and a label that
 * wraps is worse than none. Entries the user has labelled themselves are left alone —
 * see `labelCheckpoint`.
 */
export const CHECKPOINT_LABEL = "⏱ files";

/** The slice of `ctx` this extension reads beyond what `cwdOf` needs. */
interface GitCtx {
  hasUI?: boolean;
  signal?: AbortSignal;
  ui?: { notify?: (msg: string, level?: string) => void };
  sessionManager?: SessionManagerLike & {
    getCwd?: () => string;
    getSessionId?: () => string;
    getLabel?: (entryId: string) => string | undefined;
  };
}

/**
 * pi-git — undo and redo for files, following the session tree.
 *
 * No agent tools and no verbs on the slash command: rewinding is something the
 * harness does, not something the model asks for. `/pi-git` is configuration only.
 *
 * Four hooks:
 *   `tool_call`          record a file's state *before* write/edit changes it
 *   `message_start`      checkpoint the state a user message was sent in
 *   `session_before_tree` checkpoint the state being navigated away from
 *   `session_tree`       restore the state at the destination
 *
 * Plus the fork pair (`session_before_fork` / `session_shutdown`), which is how Pi
 * used to expose rewind before it had tree navigation.
 */
export default function piGit(pi: ExtensionAPI): void {
  const emit = (event: string, data: unknown) => pi.events.emit(event, data);
  const session = createGitSession();

  // Genuine hook-to-hook handoff: one hook observes something the next one acts on.
  // Grouped rather than loose so what survives between hooks is one thing to reason
  // about, and so it is obvious this is all of it.
  const pending: { fork: PendingFork | null; treeTarget: string | null } = {
    fork: null,
    treeTarget: null,
  };

  /** Narrow Pi's context once, rather than casting at each of a dozen use sites. */
  const asGit = (ctx: unknown): GitCtx => (ctx ?? {}) as GitCtx;

  /**
   * The preamble every hook shared: load the config, honor `mode: "off"`, resolve the
   * store, and contain any failure.
   *
   * Containment is the point. A checkpoint is a side effect of a turn the user asked
   * for, and a hook that throws takes the turn with it — so a failure here is reported
   * and dropped, never propagated. `what` names the operation in that report.
   */
  async function withStore(
    what: string,
    ctx: unknown,
    run: (store: CheckpointStore, cfg: GitConfig, git: GitCtx) => Promise<void>,
  ): Promise<void> {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const git = asGit(ctx);
    const store = session.store(git, cfg.maxFileBytes);
    if (!store) return;
    try {
      await run(store, cfg, git);
    } catch (error) {
      console.error(`[pi-git] ${what} failed: ${(error as Error).message}`);
    }
  }

  /**
   * Say what was left out. A file silently excluded from a rewind is worse than a slow
   * one.
   *
   * Reported to the user, not onto the event bus: the bus vocabulary is closed (see
   * `shared/events.ts` and the contract test), and widening it would make a pi-git
   * implementation detail part of the cross-extension surface.
   */
  function reportSkips(ctx: GitCtx): void {
    for (const skip of session.drainSkips()) {
      const message = `[pi-git] ${skip.path} is too large to checkpoint (${skip.bytes} bytes) — a rewind will not restore it.`;
      if (ctx.hasUI) ctx.ui?.notify?.(message, "warning");
      else console.error(message);
    }
  }

  /**
   * What to capture: every path pi-git already tracks, plus whatever git reports as
   * changed. The second half is what catches a file `bash` wrote, which never passes
   * through a tool call. Detection is a supplement — a failure there must not stop the
   * checkpoint, and outside a repository it simply contributes nothing.
   */
  async function pathsFor(store: CheckpointStore, cfg: GitConfig, ctx: GitCtx): Promise<string[]> {
    const paths = new Set(store.tracked());
    if (cfg.detectDirty) {
      try {
        for (const path of await dirtyPaths(defaultExec, cwdOf(ctx), { signal: ctx.signal })) {
          paths.add(path);
        }
      } catch {
        /* best effort */
      }
    }
    return [...paths];
  }

  /**
   * Mark an entry as restorable, for the `/tree` picker.
   *
   * Never overwrites a label that is already there. Labels are a *user* feature —
   * bookmarks they set themselves — and pi-git silently replacing
   * "before the auth refactor" with its own marker would be taking a note the user
   * wrote and throwing it away. Where the two collide the user's wins; the checkpoint
   * still exists and still restores, it just is not the thing announcing itself.
   */
  function labelCheckpoint(git: GitCtx, entryId: string): void {
    try {
      if (git.sessionManager?.getLabel?.(entryId)) return;
      pi.setLabel?.(entryId, CHECKPOINT_LABEL);
    } catch {
      /* labelling is an affordance, never a reason to fail a checkpoint */
    }
  }

  /** Checkpoint `paths` against `entryId`, label it, then report anything left out. */
  async function capture(
    store: CheckpointStore,
    cfg: GitConfig,
    ctx: GitCtx,
    entryId: string,
    reason: string,
  ): Promise<void> {
    await checkpointTurn(store, entryId, await pathsFor(store, cfg, ctx), reason, emit);
    labelCheckpoint(ctx, entryId);
    reportSkips(ctx);
  }

  // Fires *before* the tool runs, with typed input — the only moment the pre-edit
  // bytes are still on disk. This is what lets a restore delete a file the agent
  // created, rather than guessing from its later presence.
  pi.on("tool_call", async (event, ctx) => {
    if (!EDIT_TOOLS.has(event.toolName)) return;
    const path = editedPath(event.input);
    if (!path) return;
    await withStore(`recording ${path}`, ctx, async (store, _cfg, git) => {
      await store.rememberOrigin(resolve(cwdOf(git), path));
    });
  });

  // Checkpoint the pre-edit state once per turn. The user message only becomes the
  // committed leaf when the first assistant message of the turn starts, so anchor
  // there; dedup by entry id so later assistant messages don't overwrite it.
  pi.on("message_start", async (event, ctx) => {
    if ((event.message as { role?: string })?.role !== "assistant") return;
    await withStore("checkpoint", ctx, async (store, cfg, git) => {
      const entryId = currentUserEntryId(git.sessionManager ?? {});
      if (!entryId || entryId === session.lastCheckpointed()) return;
      await capture(store, cfg, git, entryId, "turn");
      session.markCheckpointed(entryId);
    });
  });

  /**
   * About to navigate. Two things happen here.
   *
   * The checkpoint is keyed to the *leaf*, not to the turn's user message: the user
   * message already holds the state it was sent in, and overwriting that with the
   * state being left would make "rewind to this message" a no-op. Two keys, two
   * meanings — which is what lets forward and backward navigation both be right.
   *
   * And `preparation.targetId` — the entry the user actually selected — is stashed
   * for `session_tree`, which does not carry it. Selecting a user message moves the
   * leaf to that message's *parent* and puts its text back in the composer, so
   * `newLeafId` is one entry earlier than what was chosen, and for the first message
   * of a session it is `null`. Restoring from `newLeafId` therefore missed entirely
   * at exactly the point a user most wants an undo: back to the very beginning.
   * `targetId` is the right key in both directions.
   */
  pi.on("session_before_tree", async (event, ctx) => {
    // Recorded before the mode gate: `session_tree` clears it either way, and stashing
    // it costs nothing. Skipping it here would leave a stale target behind if the mode
    // changed between the two hooks.
    pending.treeTarget = event.preparation?.targetId ?? null;
    await withStore("checkpoint before navigation", ctx, async (store, cfg, git) => {
      const leafId = currentLeafId(git.sessionManager ?? {});
      if (!leafId) return;
      await capture(store, cfg, git, leafId, "before-tree");
    });
  });

  // Navigated. Prefer the entry the user chose; fall back to the resulting leaf when
  // there was no preparation (a programmatic navigation). Either way, walk up to the
  // nearest checkpointed ancestor — the destination is often an assistant entry that
  // was never a checkpoint anchor.
  pi.on("session_tree", async (event, ctx) => {
    const chosen = pending.treeTarget;
    pending.treeTarget = null;
    await withStore("restore after navigation", ctx, async (store, _cfg, git) => {
      const sm = git.sessionManager ?? {};
      const start = chosen ?? event.newLeafId ?? currentLeafId(sm);
      let target = await resolveRestoreTarget(sm, start, (id) => store.has(id));
      if (!target) {
        const fallback = currentUserEntryId(sm);
        if (fallback && (await store.has(fallback))) target = fallback;
      }
      if (target) {
        await restoreEntry(store, target, "tree", emit);
      } else if (git.hasUI) {
        // Silence here would read as "there was nothing to undo".
        git.ui?.notify?.(
          "[pi-git] no file checkpoint for that point in the session — files left as they are.",
          "warning",
        );
      }
      // The timeline moved; the next turn must checkpoint even if its entry id repeats.
      session.markCheckpointed(null);
    });
  });

  /**
   * Prune checkpoints past their TTL.
   *
   * The only thing pi-git does that a revert cannot undo, so it is deliberately
   * conservative: age-based rather than a count cap (navigation can reach arbitrarily
   * far back, and pruning all but the newest N would silently break a restore that is
   * still reachable), never the session that is starting, and awaited rather than
   * detached so a failure is caught here instead of surfacing as an unhandled
   * rejection. When nothing has expired the sweep costs one directory listing.
   */
  pi.on("session_start", async (_event, ctx) => {
    await withStore("checkpoint sweep", ctx, async (store, cfg) => {
      await store.gc(cfg.checkpointTtlDays, Date.now());
    });
  });

  // Record the fork target; restore only once the fork actually commits (shutdown).
  pi.on("session_before_fork", async (event) => {
    pending.fork = { entryId: event.entryId, position: event.position };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const fork = pending.fork;
    pending.fork = null;
    if (event.reason !== "fork") return;
    await withStore("rewind restore", ctx, async (store) => {
      await restoreOnForkShutdown(store, fork, event.reason, emit);
    });
  });

  /**
   * The one cooperation pi-git takes part in, and the only gap in its coverage that a
   * hook could not close.
   *
   * Every other way a file changes reaches this process: through `tool_call` for the
   * edit tools, and through `detectDirty` for anything `bash` wrote. A subagent's edits
   * reach neither — they happen in a separate `pi` process — so a file that was clean
   * when the delegation began had no origin recorded, was in no manifest, and survived
   * a rewind untouched while pi-git reported success. The least supervised edits in the
   * suite were the only ones it could not undo.
   *
   * Subscribed rather than imported, so this holds against *any* publisher of
   * `spawn:started` and disappears cleanly when nothing publishes it — pi-spawn stays
   * disable-able, and pi-git keeps working with it gone.
   *
   * The payload carries `cwd` because a bus callback gets no `ExtensionContext`; the
   * store comes from `currentStore()` for the same reason.
   */
  pi.events.on("spawn:started", (data) => {
    const cfg = loadConfig();
    if (cfg.mode === "off" || !cfg.guardDelegated) return;
    const d = (data ?? {}) as { agent?: string; cwd?: string };
    // No cwd is no project to enumerate. Guessing one would guard the wrong repository,
    // which is worse than not guarding: it reports coverage it does not have.
    if (!d.cwd) return;
    const store = session.currentStore();
    if (!store) return;
    const cwd = d.cwd;

    // Detached on purpose. `pi.events.emit` is synchronous, so awaiting here would put
    // a full-tree hash on pi-spawn's critical path; the subagent takes seconds to
    // start, and `rememberOrigin` is idempotent, so racing it is safe where blocking on
    // it is rude. Failures are contained rather than surfacing as an unhandled rejection.
    void (async () => {
      try {
        const paths = new Set(await trackedPaths(defaultExec, cwd));
        for (const path of await dirtyPaths(defaultExec, cwd)) paths.add(path);
        const { skipped } = await guardDelegation(store, [...paths], cfg.maxGuardedFiles);
        if (skipped > 0) {
          // Same standard as reportSkips: a partial guard that looks total is the
          // failure mode, so say what was left out.
          console.error(
            `[pi-git] ${d.agent ?? "a subagent"} was delegated in a working set of ${paths.size} files; ` +
              `${skipped} beyond maxGuardedFiles (${cfg.maxGuardedFiles}) are not protected — a rewind will not restore them.`,
          );
        }
      } catch (error) {
        console.error(`[pi-git] guarding delegated edits failed: ${(error as Error).message}`);
      }
    })();
  });

  const command = buildGitCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
  });
  pi.registerCommand(command.name, command.options);
}
