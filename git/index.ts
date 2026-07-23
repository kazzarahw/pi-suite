import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGit, defaultExec } from "./src/git.ts";
import { loadConfig, saveConfig } from "./src/config.ts";
import { checkpointTurn, restoreOnForkShutdown, type PendingFork } from "./src/hooks.ts";
import { currentUserEntryId } from "./src/checkpoints.ts";
import { buildGitCommand } from "./src/command.ts";

/**
 * pi-git — makes Pi's message-rewind revert files too. Pure harness behavior, no
 * agent tools: checkpoint the working tree at the start of each turn (keyed to the
 * user-message entry), and on Pi's fork lifecycle restore the tree to the forked-to
 * entry.
 *
 * Build spec: docs/superpowers/plans/2026-07-20-pi-git.md
 */
export default function piGit(pi: ExtensionAPI): void {
  const cwdOf = (ctx: ExtensionContext): string => ctx?.sessionManager?.getCwd?.() ?? process.cwd();
  const emit = (event: string, data: unknown) => pi.events.emit(event, data);

  let lastCheckpointedEntryId: string | null = null;
  let pendingFork: PendingFork | null = null;

  // Checkpoint the pre-edit tree once per turn. The user message only becomes the
  // committed leaf when the first assistant message of the turn starts (verified
  // against Pi's lifecycle), so anchor there; dedup by entry id so the later
  // assistant messages of the same turn don't overwrite the pre-edit snapshot.
  pi.on("message_start", async (event, ctx) => {
    if ((event.message as { role?: string })?.role !== "assistant") return;
    if (loadConfig().mode === "off") return;
    const entryId = currentUserEntryId(ctx.sessionManager);
    if (!entryId || entryId === lastCheckpointedEntryId) return;
    const git = createGit(defaultExec, cwdOf(ctx));
    if (!(await git.isRepo())) return;
    try {
      await checkpointTurn(git, entryId, "turn", new Date().toISOString(), emit);
      lastCheckpointedEntryId = entryId;
    } catch (error) {
      console.error(`[pi-git] checkpoint failed: ${(error as Error).message}`);
    }
  });

  // Record the fork target; restore only once the fork actually commits (shutdown).
  pi.on("session_before_fork", async (event) => {
    pendingFork = { entryId: event.entryId, position: event.position };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "fork" || loadConfig().mode === "off") {
      pendingFork = null;
      return;
    }
    const git = createGit(defaultExec, cwdOf(ctx));
    try {
      if (await git.isRepo()) {
        await restoreOnForkShutdown(git, pendingFork, event.reason, emit);
      }
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
