/**
 * Context-injection tags (HOUSE-STYLE §6).
 *
 * Extensions that inject context wrap it in `<pi-<name>>` tags so the agent
 * recognizes the whole family as harness-injected. The first line inside the
 * block is a short `source · why` header so the model knows it is harness
 * output, not user text or file content.
 */

/** The shared prefix for every injection tag and package name. */
export const TAG_PREFIX = "pi-";

/** The tag for an extension's injection block, e.g. `pi-lens` -> `"pi-lens"`. */
export function tagName(shortName: string): string {
  return `${TAG_PREFIX}${shortName}`;
}

/** Compose the `source · why` header line that opens every injection block. */
export function injectionHeader(source: string, why: string): string {
  return `${source} · ${why}`;
}

/**
 * Wrap harness output in an extension's injection block.
 *
 * @param shortName the extension's short name (e.g. `"lens"`, `"memory"`)
 * @param header    the `source · why` line (see {@link injectionHeader})
 * @param body      the payload lines
 */
export function injectionBlock(shortName: string, header: string, body: string): string {
  const tag = tagName(shortName);
  return `<${tag}>\n${header}\n${body}\n</${tag}>`;
}
