/**
 * One short, stable, non-cryptographic string hash.
 *
 * pi-todo derives item ids from content and pi-memory derives a dedup key for an
 * auto-captured gotcha; both had the same multiply-by-31 loop written out. It is only
 * a few lines, which is exactly why it gets copied instead of shared — and why the two
 * copies could quietly disagree about the modulus or the radix.
 *
 * **Not for security or content addressing.** pi-git hashes file content and uses
 * `node:crypto` sha256 for it; that is the right call and stays where it is. This is
 * for short, human-readable, collision-tolerant keys.
 */

/**
 * A stable base-36 hash of `s`. Deterministic across runs and processes — no clock, no
 * salt — so ids stay reproducible in tests and across sessions.
 */
export function stableHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
