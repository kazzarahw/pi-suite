/**
 * Project trust, as the suite reads it.
 *
 * Pi's trust model (`docs/security.md`) gates the project-local resources *Pi* knows
 * about: `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`,
 * `.pi/themes`, `.pi/SYSTEM.md`. It cannot gate the ones this suite invented —
 * `.pi/memory`, which pi-memory injects into every LLM call, and `.pi/agents`, whose
 * bodies become a subagent's system prompt — because Pi has never heard of them.
 *
 * They are categorically the same thing: files a repository ships that become model
 * instructions. So the suite applies Pi's own line to its own additions. pi-lens drew
 * it first, for the autodetected verify command; this is that decision made once
 * instead of three times, which is also what keeps `test/boundaries.test.ts`'s
 * single-source rule satisfied.
 *
 * This is not a claim to prevent prompt injection — Pi is explicit that repository
 * content is expected local-agent risk. It is the narrower, preventable case: an
 * untrusted repository should not get to write the agent's standing context.
 */

/**
 * The slice of `ctx` this reads. Structural and optional for the same reason as
 * `CwdSource`: hooks, commands, and test fakes each supply a different amount of it,
 * and `shared/` stays free of Pi imports.
 */
export interface TrustSource {
  isProjectTrusted?: () => boolean;
}

/**
 * Whether project-local resources may be read.
 *
 * Absent when Pi supplies no context at all — a bus callback, an older host — and
 * `true` is the right default there: `isProjectTrusted` is a required field on a real
 * `ExtensionContext`, so its absence means "nobody asked", not "not trusted". Failing
 * closed on a missing field would silently disable project memories for every
 * subscriber rather than protecting anyone.
 */
export function projectTrusted(ctx?: TrustSource): boolean {
  return ctx?.isProjectTrusted?.() ?? true;
}
