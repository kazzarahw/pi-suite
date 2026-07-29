/**
 * A peer signal, read off the bus.
 *
 * pi-plan subscribes to `verify:passed` to show how the work is tracking against the
 * objective. It does not care who publishes it — pi-lens does today — and with no
 * publisher present nothing here runs and the fragment simply never appears. There is no
 * import in either direction, only the bus.
 *
 * This is what is left of pi-goal's `progress.ts` after the merge. Its other half read
 * `todo:updated` off the bus to count how the task list was tracking; with the list and
 * the objective now in one state, that became a field read and the defensive parsing
 * around it became nothing at all. This half did not collapse, because pi-lens is a
 * genuine peer rather than the other half of the same extension.
 *
 * Payloads are treated as untrusted for the same reason they are self-contained: a
 * subscriber is handed `data` and nothing else, and the publisher may not be the sibling
 * that ships today.
 */

/** The project's checks passed, and what command said so. */
export interface VerifyState {
  cmd: string;
}

/**
 * Read a `verify:passed` payload.
 *
 * `objective.criteria` is literally "how you will know the objective is met", and a
 * passing test/build command is the strongest evidence available for that — so pi-plan
 * surfaces it, in the widget and in the settle reminder.
 *
 * It never marks anything **met**, and it never touches a nudge guard. Whether passing
 * checks satisfy *this* objective is a judgement about intent, which the agent makes with
 * `plan({ action: "objective", status: "met" })`. An extension that decided it from a
 * green test run would be answering a different question than the one the objective asked,
 * and closing it on the agent's behalf.
 *
 * The payload's `cwd` is deliberately ignored rather than compared: pi-plan only displays
 * this, and both extensions resolve their cwd from the same session, so a `verify:passed`
 * reaching this handler is by construction about this session's project. Latching a cwd to
 * check it against is the pattern pi-memory removed for good reason.
 */
export function readVerify(data: unknown): VerifyState | null {
  const cmd = (data as { cmd?: unknown } | undefined)?.cmd;
  return typeof cmd === "string" && cmd.length > 0 ? { cmd } : null;
}
