/**
 * When to run the verify pass.
 *
 * pi-lens does not verify after every edit — it waits for the agent to settle, and only
 * then if an edit actually landed and the file parses cleanly. Running tests against
 * code with a syntax error wastes a test run to tell the agent something the diagnostics
 * already said.
 *
 * That policy lived as three module-level booleans in `index.ts`, written by one hook
 * and read by another. Nothing was wrong with the logic; the problem was that exercising
 * it meant driving two hooks in the right order with the right fake context, so it was
 * covered only incidentally — `index.ts` sat at 74% with these lines among the gaps.
 * As a value object it is a handful of one-line tests.
 *
 * Deliberately not on the event bus: the coupling is internal to pi-lens, and a
 * `lens:clean` round trip would make one extension's private sequencing into part of the
 * cross-extension surface.
 */

export interface VerifyGate {
  /** Record the outcome of a diagnostics pass. `isEdit` false for a plain read. */
  noteDiagnostics(diagnostics: ReadonlyArray<{ severity: string }>, isEdit: boolean): void;
  /** Should a settle run the verify command? */
  shouldVerify(): boolean;
  /** Mark a verify as started — clears the dirty flag so one settle runs it once. */
  consume(): void;
  /**
   * True the first time only. For a notice that explains a skip: repeating it on every
   * settle turns a useful warning into noise the user learns to ignore.
   */
  warnOnce(): boolean;
}

export function createVerifyGate(): VerifyGate {
  let dirty = false; // an edit landed since the last verify
  let hasErrors = false; // last diagnostics had unresolved errors → don't verify yet
  let warned = false;

  return {
    noteDiagnostics(diagnostics, isEdit) {
      const errors = diagnostics.some((d) => d.severity === "error");
      if (isEdit) {
        // An edit both makes the tree dirty and replaces the verdict: it is the write the
        // gate is waiting on, so whatever it left behind is the current answer. This is
        // what lets a fix reopen the gate without a further edit.
        dirty = true;
        hasErrors = errors;
        return;
      }
      // A read only ever *adds* to the verdict, and the asymmetry is the same one `dirty`
      // already has: a read is about some other file, so finding it clean is no evidence
      // that the edited one parses. Letting a clean read clear the flag meant the very
      // common "edit A, glance at B, settle" sequence ran the verify against the syntax
      // error A had just introduced — which is the one thing this gate exists to prevent.
      // Errors found by a read still hold it shut: the tree is broken, whoever noticed.
      if (errors) hasErrors = true;
    },
    shouldVerify() {
      return dirty && !hasErrors;
    },
    consume() {
      dirty = false;
    },
    warnOnce() {
      if (warned) return false;
      warned = true;
      return true;
    },
  };
}
