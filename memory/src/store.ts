import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMemory, serializeMemory, type Memory, type Scope } from "./frontmatter.ts";

/** Global (agent-config) and project memory dirs. Honors PI_CODING_AGENT_DIR (also lets tests redirect global). */
export function memoryDirs(cwd: string): { global: string; project: string } {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return { global: join(agentDir, "memory"), project: join(cwd, ".pi", "memory") };
}

const slug = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");

const fileFor = (dir: string, name: string): string => join(dir, `${slug(name)}.md`);

function readDir(dir: string, scope: Scope): Memory[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
  } catch {
    return [];
  }
  const out: Memory[] = [];
  for (const f of files) {
    const parsed = parseMemory(readFileSync(join(dir, f), "utf8"));
    if (parsed) out.push({ ...parsed, scope });
    else console.error(`[pi-memory] skipping malformed memory: ${join(dir, f)}`);
  }
  return out;
}

function rewriteIndex(dir: string, scope: Scope): void {
  const mems = readDir(dir, scope);
  if (mems.length === 0) {
    try {
      rmSync(join(dir, "INDEX.md"), { force: true });
    } catch {
      /* ignore */
    }
    return;
  }
  const lines = mems.map((m) => `- ${m.name} — ${m.description}`).sort();
  try {
    writeFileSync(join(dir, "INDEX.md"), `# Memory Index\n\n${lines.join("\n")}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

export function listMemories(cwd: string): Memory[] {
  const { global, project } = memoryDirs(cwd);
  return [...readDir(global, "global"), ...readDir(project, "project")];
}

export function readMemory(name: string, cwd: string): Memory | null {
  return listMemories(cwd).find((m) => m.name === name) ?? null;
}

/** Write a memory, deduping by name across scopes (removes any existing, writes to the target scope). */
export function writeMemory(m: Memory, cwd: string): void {
  deleteMemory(m.name, cwd);
  const { global, project } = memoryDirs(cwd);
  const dir = m.scope === "project" ? project : global;
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, m.name), serializeMemory(m), "utf8");
  rewriteIndex(dir, m.scope);
}

export function deleteMemory(name: string, cwd: string): void {
  const { global, project } = memoryDirs(cwd);
  for (const [dir, scope] of [
    [global, "global"],
    [project, "project"],
  ] as const) {
    const f = fileFor(dir, name);
    if (existsSync(f)) {
      rmSync(f, { force: true });
      rewriteIndex(dir, scope);
    }
  }
}
