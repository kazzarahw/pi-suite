import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentDir, projectConfigDir } from "../../shared/config.ts";
import { parseMemory, serializeMemory, type Memory, type Scope } from "./frontmatter.ts";

/** Global (agent-config) and project memory dirs, both through the suite's one resolver. */
export function memoryDirs(cwd: string): { global: string; project: string } {
  return { global: join(agentDir(), "memory"), project: projectConfigDir(cwd, "memory") };
}

/**
 * Whether a read may include the project scope.
 *
 * Required rather than defaulted, and named rather than a bare boolean, because the
 * failure it prevents is silent: a call site that forgot the flag would inject a
 * cloned repository's memories into every LLM call and look exactly like one that
 * did not. Making it required means the compiler enumerates the call sites.
 */
export interface ReadScope {
  /** Include `<cwd>/.pi/memory` — i.e. `projectTrusted(ctx)`. See `shared/trust.ts`. */
  includeProject: boolean;
}

/** Every scope, for the write paths and for callers that have already decided. */
export const ALL_SCOPES: ReadScope = { includeProject: true };

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

// --- Index cache -----------------------------------------------------------

/**
 * `listMemories` is called from the `context` hook — before **every** LLM call — and
 * previously re-read and re-parsed every memory file each time. The cache replaces
 * that with a directory listing plus one `stat` per file.
 *
 * Revalidation is per *file*, not per directory. A directory's mtime moves only when
 * an entry is created, renamed, or removed, so a directory-mtime check would miss a
 * memory edited in place — by `$EDITOR`, by another Pi session, or by an agent writing
 * the file directly — and serve stale content for the rest of the session. Comparing
 * each file's mtime and size costs one extra `stat` and closes that hole.
 *
 * Keyed by the resolved directory pair rather than by `cwd`: the global directory
 * depends on the agent dir, which can differ between two lookups of the same project.
 *
 * The scope is part of the key too. Without it, one trusted read would populate the
 * cache with the project's memories and every later untrusted read would be served
 * them — the gate would hold on the first call of a session and leak on all the rest.
 */
interface CacheEntry {
  signature: string;
  memories: readonly Memory[];
}

const indexCache = new Map<string, CacheEntry>();

const cacheKey = (dirs: { global: string; project: string }, scope: ReadScope): string =>
  `${dirs.global}\0${dirs.project}\0${scope.includeProject ? "p" : "-"}`;

/** `name:mtime:size` for every memory file in `dir`, or `"-"` when the directory is absent. */
function dirSignature(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
  } catch {
    return "-";
  }
  names.sort();
  const parts: string[] = [];
  for (const name of names) {
    try {
      const s = statSync(join(dir, name));
      parts.push(`${name}:${s.mtimeMs}:${s.size}`);
    } catch {
      /* removed between the listing and the stat — the next call will see it gone */
    }
  }
  return parts.join("|");
}

/**
 * Drop cached entries. Called by every write path here; the mtime check additionally
 * covers changes made by another process. Omit `cwd` to clear every project.
 */
export function invalidateIndexCache(cwd?: string): void {
  if (cwd === undefined) {
    indexCache.clear();
    return;
  }
  const dirs = memoryDirs(cwd);
  // Both scopes: a write is scoped, but it invalidates whichever cached views could
  // have shown it, and there are only two.
  indexCache.delete(cacheKey(dirs, { includeProject: true }));
  indexCache.delete(cacheKey(dirs, { includeProject: false }));
}

/**
 * Every memory, global first. The returned array is the cached one — shared, frozen,
 * and `readonly` so a caller cannot sort it in place and corrupt the cache for the
 * rest of the session.
 *
 * `scope.includeProject` is the trust gate: `<cwd>/.pi/memory` is repository content,
 * and this list is injected into every LLM call.
 */
export function listMemories(cwd: string, scope: ReadScope): readonly Memory[] {
  const dirs = memoryDirs(cwd);
  const key = cacheKey(dirs, scope);
  const signature = `${dirSignature(dirs.global)}\0${
    scope.includeProject ? dirSignature(dirs.project) : "-"
  }`;

  const hit = indexCache.get(key);
  if (hit && hit.signature === signature) return hit.memories;

  const memories = Object.freeze([
    ...readDir(dirs.global, "global"),
    ...(scope.includeProject ? readDir(dirs.project, "project") : []),
  ]);
  indexCache.set(key, { signature, memories });
  return memories;
}

export function readMemory(name: string, cwd: string, scope: ReadScope): Memory | null {
  return listMemories(cwd, scope).find((m) => m.name === name) ?? null;
}

/** What a write did that the caller may need to tell the user about. */
export interface WriteResult {
  /**
   * The project memory directory, when this write is what created it — otherwise `null`.
   *
   * A `project`-scope memory lands in `<cwd>/.pi/memory`, which means pi-memory creates a
   * directory inside the user's repository. It did that silently, and the first anyone
   * knew of it was an unexplained untracked `.pi/` in `git status` — directly beside
   * pi-git's promise that nothing is written into your project. Reported once, on the
   * write that creates it, rather than on every write after.
   */
  createdProjectDir: string | null;
}

/**
 * Write a memory, replacing any existing one of the same name **within its own scope**.
 *
 * Scope-limited deliberately: this previously deduped across both scopes, so writing a
 * project memory silently destroyed a same-named global one. Names are scoped — a
 * project note called "build-cmd" is a different fact from a global one, and keeping
 * both is the point of having scopes at all.
 */
export function writeMemory(m: Memory, cwd: string): WriteResult {
  deleteMemory(m.name, cwd, m.scope);
  const { global, project } = memoryDirs(cwd);
  const dir = m.scope === "project" ? project : global;
  // Checked before the mkdir, because afterwards there is no way to tell a directory this
  // call created from one that was already there. See WriteResult.
  const created = m.scope === "project" && !existsSync(dir) ? dir : null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, m.name), serializeMemory(m), "utf8");
  rewriteIndex(dir, m.scope);
  invalidateIndexCache(cwd);
  return { createdProjectDir: created };
}

/**
 * Delete a memory by name.
 *
 * Omitting `scope` removes it from both — what a user naming a memory to delete
 * should get. `writeMemory` always passes a scope, so an update can never reach
 * across into the other one.
 */
export function deleteMemory(name: string, cwd: string, scope?: Scope): void {
  const { global, project } = memoryDirs(cwd);
  const targets = (
    [
      [global, "global"],
      [project, "project"],
    ] as const
  ).filter(([, s]) => scope === undefined || s === scope);

  for (const [dir, s] of targets) {
    const f = fileFor(dir, name);
    if (existsSync(f)) {
      rmSync(f, { force: true });
      rewriteIndex(dir, s);
    }
  }
  invalidateIndexCache(cwd);
}
