import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-browser — the web, in house style.
 *
 * Registers `browser_navigate` / `browser_snapshot` / `browser_click` /
 * `browser_type` / `browser_screenshot` (thin wrappers over the `agent-browser`
 * CLI) plus `web_search` / `web_fetch`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-browser.md
 *   (Build step 2 is a hard gate: confirm the real `agent-browser` CLI first.)
 */
export default function piBrowser(pi: ExtensionAPI): void {
  // TODO: wire the agent-browser wrapper and web tools per the spec.
}
