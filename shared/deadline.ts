/**
 * Combine a caller's abort signal with a deadline.
 *
 * Two independent reasons to stop waiting — the user pressed Esc, or the operation
 * outlived its bound — and both must be honored. Threading them as separate
 * parameters is how pi-lens's tool came to honor neither: it accepted an
 * `AbortSignal` and discarded it, so a wedged language server could not be
 * cancelled *or* timed out. One signal carrying both causes is harder to drop.
 */

/**
 * A signal that aborts when `parent` aborts or when `ms` elapses, whichever is first.
 *
 * The deadline branch aborts with a `TimeoutError` reason, so a caller that cares can
 * distinguish "the user cancelled" from "this took too long".
 */
export function deadline(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
