import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-memory — persistent, write-back memory.
 *
 * Registers `memory_recall` / `memory_write`, injects the memory index on
 * session start (progressive disclosure), auto-captures a gotcha on
 * `verify:failed`, and emits `memory:wrote` / `memory:recalled`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-memory.md
 */
export default function piMemory(pi: ExtensionAPI): void {
  // TODO: wire the file store, recall/format, tools, and hooks per the spec.
}
