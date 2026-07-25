/**
 * One markdown frontmatter parser.
 *
 * pi-memory and pi-spawn both read `---`-delimited markdown — memories and agent
 * definitions — and each carried a byte-identical copy of this regex and key/value
 * loop. Two copies of a parser is two places for a format to drift, and the format is
 * a file on disk that users hand-edit.
 *
 * Deliberately minimal: a flat `key: value` map, no YAML. Neither caller needs nesting,
 * and pulling in a YAML dependency for this would put a runtime dependency in a package
 * that has none (see `scripts/smoke-install.sh`).
 */

export interface Frontmatter {
  /** The `key: value` lines above the closing `---`, trimmed. */
  meta: Record<string, string>;
  /** Everything after the closing `---`, trimmed. */
  body: string;
}

/**
 * Split `---`-delimited frontmatter from a body. `null` when the text has no
 * frontmatter block at all — callers treat that as malformed and skip the file.
 *
 * A key with no value yields `""`; a line with no `:` is ignored. Both are what the
 * two callers already did, and both are shapes a hand-edited file actually takes.
 */
export function parseFrontmatter(fileText: string): Frontmatter | null {
  const match = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, block, body] = match;

  const meta: Record<string, string> = {};
  for (const line of (block ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) meta[key] = line.slice(idx + 1).trim();
  }
  return { meta, body: (body ?? "").trim() };
}
