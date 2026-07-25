/**
 * The suite's single working-directory resolution.
 *
 * Pi's session cwd is not the extension host's `process.cwd()`. Where they differ,
 * anything resolved from `process.cwd()` acts on the wrong project: pi-lens rooted
 * its language servers there (for the whole session, since it captured the value at
 * load time), linters and the verify command ran there, and pi-memory's auto-capture
 * wrote memories there.
 *
 * This existed already — as four verbatim copies of
 * `ctx?.sessionManager?.getCwd?.() ?? process.cwd()`, in pi-git, pi-memory (twice),
 * and pi-spawn. The five sites that were broken are exactly the ones the copy-paste
 * missed. The duplication was the cause, so the fix is one implementation plus a
 * source-scan guard (see `test/boundaries.test.ts`) rather than a fifth copy.
 */

/**
 * The shape read from Pi's `ExtensionContext`. Deliberately structural and fully
 * optional rather than importing Pi's type: hooks, commands, and bus callbacks each
 * supply a different amount of this, and `shared/` stays free of Pi imports.
 */
export interface CwdSource {
  sessionManager?: { getCwd?: () => string };
}

/** The session's working directory, or the process's when Pi does not supply one. */
export function cwdOf(ctx?: CwdSource): string {
  return ctx?.sessionManager?.getCwd?.() ?? process.cwd();
}
