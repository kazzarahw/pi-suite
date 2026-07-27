/**
 * Reading Pi's file-tool call inputs.
 *
 * pi-git and pi-lens both hook `tool_call`/`tool_result` on the file tools and both need
 * the path out of an untyped `event.input`. They disagreed: pi-lens accepted `path` and
 * `file_path`, pi-git accepted only `path` — so a file edited through the other key was
 * never checkpointed, and a rewind silently left it as it was. Silently failing to record
 * a file is the exact failure pi-git exists to prevent.
 *
 * The tool-name sets lived in two places for the same reason. One definition each.
 */

/** Tools that change a file on disk — the ones worth checkpointing and re-linting. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** Tools that touch a file at all, including reads — pi-lens reports diagnostics on these. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/**
 * Tools that can change files without naming them in their input.
 *
 * `bash` takes a command string — a `sed -i`, a heredoc, a `git apply`, a plain `>`
 * redirect. `editedPath` has nothing to read, so pi-git's checkpoint hook cannot learn
 * which file is about to change; and a file first *seen* after the fact gets its already
 * modified bytes recorded as its origin, which makes the change permanently unrestorable
 * while a rewind still reports success. pi-git answers by guarding the whole working set
 * before these run, and this set is what it matches on.
 *
 * Deliberately narrow. Membership costs a tree hash the first time it fires, so this
 * names the tools that genuinely write *and* are genuinely opaque — not everything that
 * is not a read.
 */
export const OPAQUE_WRITE_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/** The shape a file tool's input takes. Both spellings are in use across Pi's tools. */
interface FileToolInput {
  path?: unknown;
  file_path?: unknown;
}

/**
 * The path a file tool is acting on, or `null` when the input carries neither key.
 *
 * May be relative — callers resolve against `cwdOf(ctx)`, never against the extension
 * host's own directory.
 */
export function editedPath(input: unknown): string | null {
  const i = input as FileToolInput | undefined;
  // First *usable* value, not first defined one: `??` would stop at a `path: ""` and
  // discard a perfectly good `file_path` beside it.
  for (const raw of [i?.path, i?.file_path]) {
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return null;
}
