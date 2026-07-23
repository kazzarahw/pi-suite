import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-browser — the web, in house style.
 *
 * Registers one `browser` tool (an `action` enum wrapping the `agent-browser`
 * CLI's verbs — snapshot/open/click/type/…) plus `web_search` / `web_fetch`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-browser.md
 *   (Build step 2 is a hard gate: confirm the real `agent-browser` CLI first
 *    via `agent-browser skills get core --full`.)
 */
export default function piBrowser(pi: ExtensionAPI): void {
  // TODO: wire the `browser` action dispatch and the web tools per the spec.
}
