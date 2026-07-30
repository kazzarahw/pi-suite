import { parseFrontmatter } from "../../shared/index.ts";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const SCOPES = ["global", "project"] as const;
export type Scope = (typeof SCOPES)[number];

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  scope: Scope;
  body: string;
}

/** Parse a memory file (frontmatter name/description/type + body). Scope comes from the dir, not the file. Null if malformed. */
export function parseMemory(fileText: string): Omit<Memory, "scope"> | null {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return null;
  const { meta, body } = parsed;
  if (!meta.name) return null;

  const type = (MEMORY_TYPES as readonly string[]).includes(meta.type ?? "")
    ? (meta.type as MemoryType)
    : "reference";

  return { name: meta.name, description: meta.description ?? "", type, body };
}

/**
 * Collapse a frontmatter value onto one line.
 *
 * The format is `key: value` per line, terminated by `---`, and both fields here are
 * agent-supplied free text. A newline in a description split the value across lines, so
 * the tail was reparsed as garbage keys — and a description containing `\n---\n` closed
 * the block outright, turning the rest of it into the memory's body. Either way the file
 * round-tripped into something other than what was stored, which for a store injected
 * into every LLM call is worse than a rejected write.
 */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

/** Serialize a memory to markdown+frontmatter (scope is NOT written — it's the dir). */
export function serializeMemory(m: Memory): string {
  return `---\nname: ${oneLine(m.name)}\ndescription: ${oneLine(m.description)}\ntype: ${m.type}\n---\n${m.body}\n`;
}
