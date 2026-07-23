import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-git — safety net for autonomous edits. Pure harness behavior, no agent tools.
 *
 * Checkpoints the working tree each turn (keyed to the user-message entry id) and
 * restores it when the user rewinds a message — hooking Pi's fork lifecycle
 * (session_before_fork -> session_shutdown{reason:"fork"}) so a message-rewind
 * reverts files too. Emits `git:checkpoint` / `git:rollback`; exposes an internal
 * worktree capability for pi-spawn. Config-only command `/pi-git`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-git.md
 */
export default function piGit(pi: ExtensionAPI): void {
  // TODO: wire the checkpoint hook, the fork-restore hook, and the worktree capability per the spec.
}
