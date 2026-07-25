import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { agentDir } from "../../shared/config.ts";

/**
 * Content-addressed file checkpoints, keyed by absolute path.
 *
 * **Why not git.** pi-git used to snapshot the working tree with git plumbing:
 * `git add -A` into a temporary index, `write-tree`, `commit-tree`. That has a
 * boundary — the work tree — and a session rooted above a nested repository falls
 * off it. `add -A` records the inner repository as a gitlink (mode 160000) and
 * captures none of its contents, so a restore reverted the outer file, left the
 * inner one edited, and reported success. Prior art agrees this is the hard case:
 * of four Pi rewind extensions, two ignore it and the most mature one excludes
 * nested repositories outright, telling the user to start Pi in the inner root.
 *
 * An absolute path has no root, so it has no boundary, so a nested repository is
 * not a special case. Git still has a job — enumerating what changed, in
 * `detect.ts` — but it is a change *detector*, never storage.
 *
 * **Layout.** Manifests at `<root>/<sessionId>/<entryId>.json`, file content at
 * `<root>/blobs/<sha256>`. Blobs are shared across sessions and entries, so a file
 * checkpointed unchanged across fifty turns is stored once.
 *
 * All I/O is synchronous behind an async interface. The files are small, and a
 * checkpoint taken from a hook wants to complete before the turn proceeds; the size
 * cap bounds the worst case.
 */

/** A file's recorded state: its content hash, or the fact that it did not exist. */
export type FileState = { hash: string; mode?: number } | { absent: true };

/** Absolute path → state, for one entry. */
export type Manifest = Record<string, FileState>;

export interface CheckpointStore {
  /** Record the state of every path, keyed to a session entry. Returns what it recorded. */
  checkpoint(entryId: string, paths: readonly string[]): Promise<Manifest>;
  /** Record a path's state the first time it is seen; never overwrites an existing origin. */
  rememberOrigin(path: string): Promise<void>;
  /** Put every tracked path back to its state at `entryId` (or its origin). */
  restore(entryId: string): Promise<{ written: string[]; removed: string[] }>;
  has(entryId: string): Promise<boolean>;
  /** Every path this session has an origin for. */
  tracked(): readonly string[];
  /** Drop sessions older than `ttlDays`, then blobs nothing surviving references. */
  gc(ttlDays: number, nowMs: number): Promise<{ sessions: number; blobs: number }>;
}

export interface StoreOptions {
  /** Defaults to `<agentDir()>/checkpoints`. Injected in tests. */
  root?: string;
  /** Files larger than this are skipped and reported rather than stored. */
  maxFileBytes?: number;
  /** Called for each file skipped for size, so the skip is visible rather than silent. */
  onSkip?: (path: string, bytes: number) => void;
}

export const DEFAULT_MAX_FILE_BYTES = 10_485_760; // 10 MB

const ORIGIN_FILE = "origin.json";
const BLOBS_DIR = "blobs";

/** Session and entry ids reach the filesystem as names; keep them to one path segment. */
const safeName = (id: string): string => id.replace(/[^\w.-]+/g, "_").slice(0, 128) || "_";

/**
 * The canonical key for a path.
 *
 * Resolved through `realpath` so that two names for one file — a symlink and its
 * target, `/tmp` and `/private/tmp` — do not become two independently-restored
 * entries. Pi's edit tool follows symlinks, so the path it reports is often the link.
 * For a path that does not exist yet, only the directory is resolved, which keeps a
 * file's key stable across the moment it is created.
 */
function normalizePath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    /* missing, or a dangling symlink */
  }
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

/** Newest mtime anywhere in a session directory — the basis for its age. */
function newestMtime(dir: string): number {
  let newest = 0;
  try {
    newest = statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
  for (const name of readdirSync(dir)) {
    try {
      newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
    } catch {
      /* raced away */
    }
  }
  return newest;
}

export function createStore(sessionId: string, opts: StoreOptions = {}): CheckpointStore {
  const root = opts.root ?? join(agentDir(), "checkpoints");
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const session = safeName(sessionId);
  const sessionDir = join(root, session);
  const blobsDir = join(root, BLOBS_DIR);
  const originFile = join(sessionDir, ORIGIN_FILE);
  const manifestFile = (entryId: string): string => join(sessionDir, `${safeName(entryId)}.json`);

  // Re-read per operation rather than held for the session's life: a fork restores
  // through a store built in a different call, and two Pi processes may share a
  // session directory. The file is small and this runs a handful of times per turn.
  const loadOrigin = (): Manifest => readJson<Manifest>(originFile) ?? {};

  /**
   * The state of one file, or `null` for "not this store's business" — a directory,
   * a dangling symlink, a socket, or a file past the size cap. `null` is deliberately
   * distinct from `{absent: true}`: recording a skipped file as absent would make a
   * later restore *delete* it.
   */
  function capture(key: string): FileState | null {
    let st;
    try {
      st = lstatSync(key);
    } catch {
      return { absent: true };
    }
    if (!st.isFile()) return null;
    if (st.size > maxFileBytes) {
      opts.onSkip?.(key, st.size);
      return null;
    }

    // Every capture reads the file. A `(mtime, size)` cache to skip unchanged files
    // was tried and removed: Linux filesystem timestamps are granular to a timer tick,
    // so two same-size writes inside one tick share an mtime and the cache serves the
    // first one's hash — silently checkpointing content that was never on disk. Git
    // calls this the "racy index" problem and resolves it by re-reading. A hook that
    // records the wrong bytes is the exact failure this store exists to prevent, and
    // the read is cheap next to the `git status` already running beside it.
    const mode = st.mode & 0o777;
    const bytes = readFileSync(key);
    const hash = createHash("sha256").update(bytes).digest("hex");

    const blob = join(blobsDir, hash);
    if (!existsSync(blob)) {
      mkdirSync(blobsDir, { recursive: true });
      writeFileSync(blob, bytes);
    }
    return { hash, mode };
  }

  /** Remove `dir` and its ancestors for as long as each is empty. */
  function pruneEmptyDirs(dir: string): void {
    let d = dir;
    for (;;) {
      try {
        rmdirSync(d); // fails on ENOTEMPTY, which is exactly where we want to stop
      } catch {
        return;
      }
      const parent = dirname(d);
      if (parent === d) return;
      d = parent;
    }
  }

  /**
   * The manifest for an entry, preferring this session's own.
   *
   * A fork starts a new session directory but inherits its parent's entries, ids
   * included — so without this lookup, rewinding in a forked session to anything
   * that happened before the fork would find no checkpoint and silently do nothing.
   * The old ref-based storage lived in the repository and survived a fork for free;
   * this is what replaces that property. Entry ids are unique, so a manifest found
   * under another session is unambiguously the right one.
   */
  function findManifest(entryId: string): Manifest | null {
    const own = readJson<Manifest>(manifestFile(entryId));
    if (own) return own;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return null;
    }
    for (const name of names) {
      if (name === BLOBS_DIR || name === session) continue;
      const found = readJson<Manifest>(join(root, name, `${safeName(entryId)}.json`));
      if (found) return found;
    }
    return null;
  }

  return {
    async rememberOrigin(path) {
      const key = normalizePath(path);
      const origin = loadOrigin();
      if (key in origin) return;
      const state = capture(key);
      if (state === null) return;
      origin[key] = state;
      writeJson(originFile, origin);
    },

    async checkpoint(entryId, paths) {
      const origin = loadOrigin();
      let originChanged = false;
      const manifest: Manifest = {};

      for (const path of paths) {
        const key = normalizePath(path);
        if (key in manifest) continue;
        const state = capture(key);
        if (state === null) continue;
        // A path first seen at checkpoint time — a file bash created, say — gets its
        // current state as its origin. The store has no evidence it was ever absent,
        // so a restore to an earlier entry will keep it rather than delete it. Not
        // deleting is the safe direction to be wrong in.
        if (!(key in origin)) {
          origin[key] = state;
          originChanged = true;
        }
        manifest[key] = state;
      }

      if (originChanged) writeJson(originFile, origin);
      writeJson(manifestFile(entryId), manifest);
      return manifest;
    },

    async has(entryId) {
      return findManifest(entryId) !== null;
    },

    tracked() {
      return Object.keys(loadOrigin());
    },

    async restore(entryId) {
      const manifest = findManifest(entryId);
      if (!manifest) return { written: [], removed: [] };

      const origin = loadOrigin();
      const written: string[] = [];
      const removed: string[] = [];

      // Every path the session knows about, not just the ones this entry recorded:
      // a path first tracked *after* `entryId` must go back to its origin, which is
      // what makes forward and backward navigation symmetric without back-filling
      // earlier manifests.
      for (const key of new Set([...Object.keys(origin), ...Object.keys(manifest)])) {
        const target = manifest[key] ?? origin[key];
        if (!target) continue;

        if ("absent" in target) {
          if (!existsSync(key)) continue;
          try {
            rmSync(key, { force: true });
          } catch {
            continue; // a file we cannot remove is not worth aborting the restore for
          }
          removed.push(key);
          pruneEmptyDirs(dirname(key));
          continue;
        }

        const blob = join(blobsDir, target.hash);
        let bytes: Buffer;
        try {
          bytes = readFileSync(blob);
        } catch {
          continue; // blob collected or corrupt — leave the file as it is
        }
        try {
          const present = existsSync(key);
          const sameBytes = present && readFileSync(key).equals(bytes);
          const sameMode = target.mode === undefined || (present && (lstatSync(key).mode & 0o777) === target.mode);
          if (sameBytes && sameMode) continue;
          if (!sameBytes) {
            mkdirSync(dirname(key), { recursive: true });
            writeFileSync(key, bytes);
          }
          // Separately from the write: `writeFileSync`'s mode option applies only when
          // the file is created, so an overwrite would silently keep the current bits
          // and a restored script would lose its +x.
          if (target.mode !== undefined) chmodSync(key, target.mode);
        } catch {
          continue;
        }
        written.push(key);
      }

      return { written, removed };
    },

    async gc(ttlDays, nowMs) {
      if (!existsSync(root)) return { sessions: 0, blobs: 0 };
      const cutoff = nowMs - ttlDays * 86_400_000;

      let sessions = 0;
      for (const name of readdirSync(root)) {
        if (name === BLOBS_DIR || name === session) continue;
        const dir = join(root, name);
        let dirMtime: number;
        try {
          const st = statSync(dir);
          if (!st.isDirectory()) continue;
          dirMtime = st.mtimeMs;
        } catch {
          continue;
        }
        // A recent directory mtime is enough to keep it, without stat-ing the
        // contents. This can only ever spare a session, never condemn one: a
        // directory's mtime moves when an entry is added, and rewriting a manifest in
        // place does not move it, so only the deeper scan can prove a session old.
        if (dirMtime >= cutoff || newestMtime(dir) >= cutoff) continue;
        rmSync(dir, { recursive: true, force: true });
        sessions += 1;
      }

      // Nothing expired means nothing can have become unreferenced, and this sweep
      // reads every manifest of every surviving session — which on startup, for a
      // heavy user, is the whole cost of gc. Skip it in the ordinary case.
      if (sessions === 0) return { sessions: 0, blobs: 0 };

      // Sweep blobs no surviving manifest — or origin — still points at.
      const referenced = new Set<string>();
      for (const name of readdirSync(root)) {
        if (name === BLOBS_DIR) continue;
        const dir = join(root, name);
        let files: string[];
        try {
          files = readdirSync(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const parsed = readJson<Manifest>(join(dir, file));
          if (!parsed) continue;
          for (const state of Object.values(parsed)) {
            if (state && "hash" in state) referenced.add(state.hash);
          }
        }
      }

      let blobs = 0;
      let names: string[];
      try {
        names = readdirSync(blobsDir);
      } catch {
        return { sessions, blobs };
      }
      for (const hash of names) {
        if (referenced.has(hash)) continue;
        rmSync(join(blobsDir, hash), { force: true });
        blobs += 1;
      }
      return { sessions, blobs };
    },
  };
}
