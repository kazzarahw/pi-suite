/**
 * The suite's agent- and user-facing surface, as data (see ./README.md).
 *
 * This is the **single source of truth**, and `test/contract.test.ts` asserts the
 * live registry matches it. It exists because the surface used to be described in
 * prose, and that description drifted from the code twice — claiming a tool count
 * that was wrong and a capability that was unreachable. Prose cannot be a contract;
 * this can.
 *
 * Seven tools total, deliberately. The rules that keep it small: automatic behavior
 * is a hook, not a tool (pi-git registers none); many variant actions collapse behind
 * one `action`-enum tool (`browser`, `lens`); and read paths are covered by tool-result
 * echoes and context injection rather than extra read tools (pi-todo, pi-memory).
 */

export interface ExtensionSurface {
  /** Directory name under the repo root — also the extension's short name. */
  readonly dir: string;
  /** The single `/pi-<name>` configuration command. */
  readonly command: string;
  /** Agent-callable tool names. Empty for hook-only extensions. */
  readonly tools: readonly string[];
}

export const SURFACE: readonly ExtensionSurface[] = [
  { dir: "memory", command: "pi-memory", tools: ["memory_recall", "memory_write"] },
  { dir: "todo", command: "pi-todo", tools: ["todo_write"] },
  { dir: "git", command: "pi-git", tools: [] },
  { dir: "consult", command: "pi-consult", tools: ["consult"] },
  { dir: "spawn", command: "pi-spawn", tools: ["spawn"] },
  { dir: "browser", command: "pi-browser", tools: ["browser"] },
  { dir: "lens", command: "pi-lens", tools: ["lens"] },
] as const;

/** Every tool the suite exposes to the agent, across all extensions. */
export const ALL_TOOLS: readonly string[] = SURFACE.flatMap((e) => e.tools);
