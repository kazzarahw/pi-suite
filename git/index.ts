import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cwdOf } from "../shared/index.ts";
import { defaultExec } from "../shared/exec.ts";
import { loadConfig, saveConfig, type GitConfig } from "./src/config.ts";
import { createStore, type CheckpointStore } from "./src/store.ts";
import { dirtyPaths } from "./src/detect.ts";
import {
  currentLeafId,
  currentUserEntryId,
  resolveRestoreTarget,
  type SessionManagerLike,
} from "./src/checkpoints.ts";
import { checkpointTurn, restoreEntry, restoreOnForkShutdown, type PendingFork } from "./src/hooks.ts";
import { buildGitCommand } from "./src/command.ts";

const EDIT_TOOLS = new Set(["write", "edit"]);

/** The slice of `ctx` this extension reads beyond what `cwdOf` needs. */
interface GitCtx {
  hasUI?: boolean;
  signal?: AbortSignal;
  ui?: { notify?: (msg: string, level?: string) => void };
  sessionManager?: SessionManagerLike & { getCwd?: () => string; getSessionId?: () => string };
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
 *
 * Build spec: docs/superpowers/plans/2026-07-20-pi-git.md
 * Storage rewrite: docs/superpowers/specs/2026-07-24-pi-suite-correctness-hardening-design.md (D10, D14)
 */
export default function piGit(pi: ExtensionAPI): void {
  const emit = (event: string, data: unknown) => pi.events.emit(event, data);

  let lastCheckpointedEntryId: string | null = null;
  let pendingFork: PendingFork | null = null;
  let cached: { sessionId: string; maxFileBytes: number; store: CheckpointStore } | null = null;

  // Files left out of a checkpoint for size. Collected rather than reported from
  // inside the store so the notice can be delivered once, from a hook that has a ctx.
  const skipped: Array<{ path: string; bytes: number }> = [];
  const announced = new Set<string>();

  /**
   * The store for this session, rebuilt only when the session or the size cap
   * changes. `null` when there is no session to key on — nothing could be restored
   * later, so there is nothing worth recording now.
   */
  function storeFor(ctx: GitCtx | undefined, cfg: GitConfig): CheckpointStore | null {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return null;
    if (cached && cached.sessionId === sessionId && cached.maxFileBytes === cfg.maxFileBytes) {
      return cached.store;
    }
    const store = createStore(sessionId, {
      maxFileBytes: cfg.maxFileBytes,
      onSkip: (path, bytes) => skipped.push({ path, bytes }),
    });
    cached = { sessionId, maxFileBytes: cfg.maxFileBytes, store };
    return store;
  }

  /**
   * Say what was left out. A file silently excluded from a rewind is worse than a
   * slow one.
   *
   * Reported to the user, not onto the event bus: the bus vocabulary is closed (see
   * `shared/events.ts` and the contract test), and widening it is a change to the
   * cross-extension surface, which this sub-project deliberately holds still.
   */
  function reportSkips(ctx: GitCtx | undefined): void {
    for (const skip of skipped.splice(0)) {
      if (announced.has(skip.path)) continue;
      announced.add(skip.path);
      const message = `[pi-git] ${skip.path} is too large to checkpoint (${skip.bytes} bytes) — a rewind will not restore it.`;
      if (ctx?.hasUI) ctx.ui?.notify?.(message, "warning");
      else console.error(message);
    }
  }

  /**
   * What to capture: every path pi-git already tracks, plus whatever git reports as
   * changed. The second half is what catches a file `bash` wrote, which never passes
   * through a tool call. Detection is a supplement — a failure there must not stop
   * the checkpoint, and outside a repository it simply contributes nothing.
   */
  async function pathsFor(store: CheckpointStore, cfg: GitConfig, ctx: GitCtx | undefined): Promise<string[]> {
    const paths = new Set(store.tracked());
    if (cfg.detectDirty) {
      try {
        for (const path of await dirtyPaths(defaultExec, cwdOf(ctx), { signal: ctx?.signal })) {
          paths.add(path);
        }
      } catch {
        /* best effort */
      }
    }
    return [...paths];
  }

  // Fires *before* the tool runs, with typed input — the only moment the pre-edit
  // bytes are still on disk. This is what lets a restore delete a file the agent
  // created, rather than guessing from its later presence.
  pi.on("tool_call", async (event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off" || !EDIT_TOOLS.has(event.toolName)) return;
    const path = (event.input as { path?: string } | undefined)?.path;
    if (typeof path !== "string" || path.length === 0) return;
    const store = storeFor(ctx as GitCtx, cfg);
    if (!store) return;
    try {
      await store.rememberOrigin(resolve(cwdOf(ctx), path));
    } catch (error) {
      console.error(`[pi-git] could not record ${path}: ${(error as Error).message}`);
    }
  });

  // Checkpoint the pre-edit state once per turn. The user message only becomes the
  // committed leaf when the first assistant message of the turn starts, so anchor
  // there; dedup by entry id so later assistant messages don't overwrite it.
  pi.on("message_start", async (event, ctx) => {
    if ((event.message as { role?: string })?.role !== "assistant") return;
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const entryId = currentUserEntryId((ctx as GitCtx).sessionManager ?? {});
    if (!entryId || entryId === lastCheckpointedEntryId) return;
    const store = storeFor(ctx as GitCtx, cfg);
    if (!store) return;
    try {
      await checkpointTurn(store, entryId, await pathsFor(store, cfg, ctx as GitCtx), "turn", emit);
      lastCheckpointedEntryId = entryId;
      reportSkips(ctx as GitCtx);
    } catch (error) {
      console.error(`[pi-git] checkpoint failed: ${(error as Error).message}`);
    }
  });

  // About to navigate. Keyed to the *leaf*, not to the turn's user message: the user
  // message already holds the state it was sent in, and overwriting that with the
  // state being left would make "rewind to this message" a no-op. Two keys, two
  // meanings — which is what lets forward and backward navigation both be right.
  pi.on("session_before_tree", async (_event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const store = storeFor(ctx as GitCtx, cfg);
    if (!store) return;
    const leafId = currentLeafId((ctx as GitCtx).sessionManager ?? {});
    if (!leafId) return;
    try {
      await checkpointTurn(store, leafId, await pathsFor(store, cfg, ctx as GitCtx), "before-tree", emit);
      reportSkips(ctx as GitCtx);
    } catch (error) {
      console.error(`[pi-git] checkpoint before navigation failed: ${(error as Error).message}`);
    }
  });

  // Navigated. Walk up from the destination to the nearest entry that has a
  // checkpoint and restore it — the destination itself is often an assistant entry
  // that was never a checkpoint anchor.
  pi.on("session_tree", async (event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const store = storeFor(ctx as GitCtx, cfg);
    if (!store) return;
    const sm = (ctx as GitCtx).sessionManager ?? {};
    try {
      const start = event.newLeafId ?? currentLeafId(sm);
      let target = await resolveRestoreTarget(sm, start, (id) => store.has(id));
      if (!target) {
        const fallback = currentUserEntryId(sm);
        if (fallback && (await store.has(fallback))) target = fallback;
      }
      if (target) {
        await restoreEntry(store, target, "tree", emit);
      } else if ((ctx as GitCtx).hasUI) {
        // Silence here would read as "there was nothing to undo".
        (ctx as GitCtx).ui?.notify?.(
          "[pi-git] no file checkpoint for that point in the session — files left as they are.",
          "warning",
        );
      }
      // The timeline moved; the next turn must checkpoint even if its entry id repeats.
      lastCheckpointedEntryId = null;
    } catch (error) {
      console.error(`[pi-git] restore after navigation failed: ${(error as Error).message}`);
    }
  });

  // Record the fork target; restore only once the fork actually commits (shutdown).
  pi.on("session_before_fork", async (event) => {
    pendingFork = { entryId: event.entryId, position: event.position };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const cfg = loadConfig();
    if (event.reason !== "fork" || cfg.mode === "off") {
      pendingFork = null;
      return;
    }
    try {
      const store = storeFor(ctx as GitCtx, cfg);
      if (store) await restoreOnForkShutdown(store, pendingFork, event.reason, emit);
    } catch (error) {
      console.error(`[pi-git] rewind restore failed: ${(error as Error).message}`);
    } finally {
      pendingFork = null;
    }
  });

  const command = buildGitCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
  });
  pi.registerCommand(command.name, command.options);
}
