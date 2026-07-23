import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-consult — a second opinion for the agent.
 *
 * Registers a `consult` tool that shells out to `claude --model <m> -p <prompt>`
 * for read-only advice and returns it as tool output, emitting `consult:answered`.
 *
 * Not yet implemented. Build spec:
 *   docs/superpowers/plans/2026-07-20-pi-consult.md
 */
export default function piConsult(pi: ExtensionAPI): void {
  // TODO: register the `consult` tool and emit `consult:answered` per the spec.
}
