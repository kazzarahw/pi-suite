/**
 * Config field validators.
 *
 * Every extension's `ConfigSpec.parse` reads a hand-editable JSON file, so every field
 * needs the same guard: is it the right type, and is it in range? That guard was written
 * out about twenty-five times across the seven `config.ts` files, and the copies
 * disagreed — pi-git rejected a non-finite number via `Number.isFinite`, while pi-lens,
 * pi-spawn, and pi-memory accepted `Infinity` because `Infinity > 0` is true. A config
 * of `{"verifyTimeoutMs": 1e999}` therefore disabled pi-lens's verify deadline entirely.
 *
 * These take git's stricter reading everywhere. Each is a pure
 * `(raw: unknown, fallback: T) => T` and never throws, matching `ConfigSpec.parse`'s
 * contract that a throw is treated as a corrupt file.
 */

/** A string, or `fallback`. Empty strings pass — `""` is meaningful (pi-lens's "autodetect"). */
export function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** A non-empty string, or `fallback`. For fields where `""` is not a usable value. */
export function nonEmptyStr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** An optional non-empty string: `undefined` when absent, blank, or the wrong type. */
export function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A finite, positive number, or `fallback`.
 *
 * Rejects `0`, negatives, `NaN`, and — the case the inline copies got wrong —
 * `Infinity`. A timeout of `Infinity` is not a long timeout; it is no timeout.
 */
export function posNum(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A finite integer `>= min` (default 1), truncated toward zero, or `fallback`. */
export function int(value: unknown, fallback: number, min = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored >= min ? floored : fallback;
}

/** A member of `allowed`, or `fallback`. The enum guard behind every `mode` field. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

/** An array of strings, keeping only the string elements, or `fallback` when not an array. */
export function strList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : fallback;
}
