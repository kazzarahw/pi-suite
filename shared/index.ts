/**
 * shared — types, constants, and helpers for the pi-suite extensions.
 *
 * The single source of truth for the cross-extension contract: the enforcement
 * dial, the event vocabulary, and the injection-tag format. An internal module of
 * the pi-suite package — imported by relative path, never as a dependency.
 *
 * `exec.ts`, `config.ts`, and `settings-panel.ts` are deliberately NOT re-exported
 * here: they carry heavier dependencies (notably pi-tui), and a barrel would put
 * those in every importer. Import them directly.
 *
 * See ./README.md for the full contract.
 */

export type { Mode } from "./mode.ts";
export { MODES, DEFAULT_MODE } from "./mode.ts";

export type { NudgeAction, NudgeGuard } from "./nudge.ts";
export { nudgeAction, createNudgeGuard } from "./nudge.ts";

export type {
  Diagnostic,
  ItemStatus,
  Step,
  PlanItem,
  EventPayloads,
  EventName,
  Emitter,
} from "./events.ts";
export { EVENTS, ITEM_STATUSES } from "./events.ts";

export { TAG_PREFIX, tagName, injectionHeader, injectionBlock } from "./tags.ts";

export type { ExtensionSurface } from "./surface.ts";
export { SURFACE, ALL_TOOLS, MANIFEST, entryPoint } from "./surface.ts";

export type { CwdSource } from "./cwd.ts";
export { cwdOf } from "./cwd.ts";

export type { TrustSource } from "./trust.ts";
export { projectTrusted } from "./trust.ts";

export { deadline } from "./deadline.ts";

export type { Frontmatter } from "./frontmatter.ts";
export { parseFrontmatter } from "./frontmatter.ts";

export { stableHash } from "./hash.ts";

export { EDIT_TOOLS, FILE_TOOLS, OPAQUE_WRITE_TOOLS, editedPath } from "./tool-input.ts";

export type { TruncateOptions } from "./truncate.ts";
export { truncateForAgent } from "./truncate.ts";
