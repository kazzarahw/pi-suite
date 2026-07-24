/**
 * The universal enforcement dial (HOUSE-STYLE §7).
 *
 * Every automation-capable extension exposes this same three-level `mode`.
 * It means the same thing everywhere; extensions may add domain-specific
 * sub-flags, but never redefine these levels.
 */

/** The three enforcement levels, shared by every automation-capable extension. */
export type Mode = "off" | "notify" | "block";

/**
 * Runtime list of the modes, in order. Feed into `StringEnum(MODES)` when
 * building a tool/config schema so the wire enum stays in sync with {@link Mode}.
 */
export const MODES = ["off", "notify", "block"] as const;

/** The default when a mode is unset: auto-run + surface feedback, never blocks. */
export const DEFAULT_MODE: Mode = "notify";
