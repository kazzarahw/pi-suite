import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-git — safety net for autonomous edits.
 *
 * Registers `git_checkpoint` / `git_rollback` / `git_worktree_*`, auto-checkpoints
 * on turn start and `todo:task-complete`, guards destructive git commands, and
 * emits `git:checkpoint` / `git:rollback`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-git.md
 */
export default function piGit(pi: ExtensionAPI): void {
  // TODO: register checkpoint/rollback/worktree tools and hooks per the spec.
}
