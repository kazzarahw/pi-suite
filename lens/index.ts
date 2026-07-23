import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-lens — real-time code feedback.
 *
 * Registers one `lens` tool (action enum: hover/references/definition/rename),
 * injects `<pi-lens>` diagnostics on read/write/edit tool results, runs the verify
 * (test/build) pass automatically on settle (hook, no tool), and emits
 * `lens:clean` / `lens:issues` / `verify:passed` / `verify:failed`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-lens.md
 */
export default function piLens(pi: ExtensionAPI): void {
  // TODO: wire the LSP client, linters, diagnostics injection, the `lens` tool, and auto-verify per the spec.
}
