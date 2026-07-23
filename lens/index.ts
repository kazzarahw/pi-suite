import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-lens — real-time code feedback.
 *
 * Registers `lens_hover` / `lens_rename` / `lens_references` / `lens_definition`
 * / `lens_verify`, injects `<pi-lens>` diagnostics on read/write/edit tool
 * results, runs the verify (test/build) pass on settle, and emits
 * `lens:clean` / `lens:issues` / `verify:passed` / `verify:failed`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-lens.md
 */
export default function piLens(pi: ExtensionAPI): void {
  // TODO: wire the LSP client, linters, diagnostics injection, and verify per the spec.
}
