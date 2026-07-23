import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-spawn — delegate to isolated subagents.
 *
 * Registers `spawn` / `spawn_parallel`, each running a delegated task in an
 * isolated `pi` subprocess (JSON event-stream mode) with streaming progress and
 * abort, and emits `spawn:started` / `spawn:finished`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-spawn.md
 */
export default function piSpawn(pi: ExtensionAPI): void {
  // TODO: wire agent discovery, the runner, the pool, and tools per the spec.
}
