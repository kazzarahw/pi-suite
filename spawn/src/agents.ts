import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, projectConfigDir } from "../../shared/config.ts";
import { parseFrontmatter } from "../../shared/index.ts";

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

/** Parse an agent markdown file (frontmatter + body). Returns null if malformed. */
export function parseAgent(fileText: string): AgentDef | null {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return null;
  const { meta, body } = parsed;
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
    systemPrompt: body,
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

// Resolved through the suite's one agent-directory helper. This used to hardcode
// `~/.pi/agent`, so a custom PI_CODING_AGENT_DIR moved every other extension's state and
// left pi-spawn reading a roster nobody was writing to — the same defect the shared
// helper was introduced to close everywhere else.
const globalAgentsDir = (): string => join(agentDir(), "agents");

/** The bundled default roster. */
export function defaultAgents(): AgentDef[] {
  return readAgentsFrom(bundledAgentsDir());
}

/**
 * Merge defaults ∪ global ∪ project, with project winning on name collisions.
 *
 * `includeProject` is the trust gate, and this is the sharper of the suite's two
 * project-local reads: an agent definition's body becomes a subagent's
 * `--append-system-prompt`, and because project entries win collisions, an untrusted
 * repository could otherwise redefine the bundled `reviewer` — keeping the name the
 * caller asked for and replacing everything it does. Required rather than defaulted,
 * so the compiler names every call site. See `shared/trust.ts`.
 */
export function discoverAgents(cwd: string, includeProject: boolean): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const a of defaultAgents()) byName.set(a.name, a);
  for (const a of readAgentsFrom(globalAgentsDir())) byName.set(a.name, a);
  if (includeProject) {
    for (const a of readAgentsFrom(projectConfigDir(cwd, "agents"))) byName.set(a.name, a);
  }
  return [...byName.values()];
}
