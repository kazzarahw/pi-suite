/**
 * shared — types, constants, and helpers for the pi-suite extensions.
 *
 * The single source of truth for the cross-extension contract: the enforcement
 * dial (§7), the event vocabulary (§4), and the injection-tag format (§6).
 * An internal module of the pi-suite package — imported by relative path, never
 * as a dependency. See docs/HOUSE-STYLE.md for the full contract.
 */

export type { Mode } from "./mode.ts";
export { MODES, DEFAULT_MODE } from "./mode.ts";

export type {
  Diagnostic,
  TodoStatus,
  TodoItem,
  EventPayloads,
  EventName,
} from "./events.ts";
export { EVENTS, TODO_STATUSES } from "./events.ts";

export { TAG_PREFIX, tagName, injectionHeader, injectionBlock } from "./tags.ts";

export type { ExtensionSurface } from "./surface.ts";
export { SURFACE, ALL_TOOLS } from "./surface.ts";

export type { CwdSource } from "./cwd.ts";
export { cwdOf } from "./cwd.ts";

export { deadline } from "./deadline.ts";

export type { TruncateOptions } from "./truncate.ts";
export { truncateForAgent } from "./truncate.ts";
