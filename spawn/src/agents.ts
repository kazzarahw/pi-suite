import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

/** Parse an agent markdown file (frontmatter + body). Returns null if malformed. */
export function parseAgent(fileText: string): AgentDef | null {
  const match = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, body] = match;

  const meta: Record<string, string> = {};
  for (const line of (frontmatter ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) meta[key] = line.slice(idx + 1).trim();
  }
  if (!meta.name) return null;

  const tools = meta.tools
    ? meta.tools
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    : undefined;

  return {
    name: meta.name,
    description: meta.description ?? "",
    model: meta.model || undefined,
    tools: tools && tools.length > 0 ? tools : undefined,
    systemPrompt: (body ?? "").trim(),
  };
}

/** Read + parse every `*.md` in a directory; missing dir → []; malformed files skipped with a warning. */
export function readAgentsFrom(dir: string): AgentDef[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const agents: AgentDef[] = [];
  for (const file of files) {
    const parsed = parseAgent(readFileSync(join(dir, file), "utf8"));
    if (parsed) agents.push(parsed);
    else console.error(`[pi-spawn] skipping malformed agent file: ${join(dir, file)}`);
  }
  return agents;
}

// Resolve the bundled agents/ dir relative to this module. Use import.meta.url
// (portable ESM) rather than import.meta.dir, which Pi's loader leaves undefined.
const bundledAgentsDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const globalAgentsDir = (): string => join(homedir(), ".pi", "agent", "agents");

/** The bundled default roster. */
export function defaultAgents(): AgentDef[] {
  return readAgentsFrom(bundledAgentsDir());
}

/** Merge defaults ∪ global ∪ project, with project winning on name collisions. */
export function discoverAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const a of defaultAgents()) byName.set(a.name, a);
  for (const a of readAgentsFrom(globalAgentsDir())) byName.set(a.name, a);
  for (const a of readAgentsFrom(join(cwd, ".pi", "agents"))) byName.set(a.name, a);
  return [...byName.values()];
}
