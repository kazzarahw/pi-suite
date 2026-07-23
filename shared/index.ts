/**
 * pi-shared — types & constants for the pi-* extension suite.
 *
 * The single source of truth for the cross-extension contract: the enforcement
 * dial (§7), the event vocabulary (§4), and the injection-tag format (§6).
 * Consumed as a devDependency; the types erase at compile time. See
 * HOUSE-STYLE.md for the full contract.
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
export { EVENTS } from "./events.ts";

export { TAG_PREFIX, tagName, injectionHeader, injectionBlock } from "./tags.ts";
