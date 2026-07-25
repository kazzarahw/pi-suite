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

/** Serialize a memory to markdown+frontmatter (scope is NOT written — it's the dir). */
export function serializeMemory(m: Memory): string {
  return `---\nname: ${m.name}\ndescription: ${m.description}\ntype: ${m.type}\n---\n${m.body}\n`;
}
