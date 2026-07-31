/**
 * The suite's agent- and user-facing surface, as data.
 *
 * This is the **single source of truth**, and `test/contract.test.ts` asserts the
 * live registry matches it. It exists because the surface used to be described in
 * prose, and that description drifted from the code twice — claiming a tool count
 * that was wrong and a capability that was unreachable. Prose cannot be a contract;
 * this can.
 *
 * Deliberately few tools. The rules that keep it small: automatic behavior is a hook,
 * not a tool (pi-git and pi-telegram register none); many variant actions collapse behind one
 * `action`-enum tool (`browser`, `lens`, `plan`); and read paths are covered by tool-result
 * echoes and context injection rather than extra read tools (pi-plan, pi-memory).
 *
 * **The count is not a property of the suite.** Extensions are peers: any one can be
 * disabled, replaced, or prototyped against by editing this list and `package.json`
 * together. Nothing here or in the tests may assume a particular count — see
 * `test/contract.test.ts`, which asserts properties that hold for any subset.
 */

export interface ExtensionSurface {
  /** Directory name under the repo root — also the extension's short name. */
  readonly dir: string;
  /** The single `/pi-<name>` configuration command. */
  readonly command: string;
  /** Agent-callable tool names. Empty for hook-only extensions. */
  readonly tools: readonly string[];
  /**
   * This extension augments other extensions' `tool_result` output, so it must load
   * last.
   *
   * Pi chains `tool_result` handlers as middleware in load order, and the outermost
   * wrapper is the one that runs last. pi-lens appends its diagnostics block to
   * whatever the tool returned, so if it loaded first its injection would be the thing
   * a later handler wrapped, rather than the other way round.
   *
   * Declared here rather than narrated in a README because it is a constraint on
   * `package.json`, and `test/contract.test.ts` checks it — but only for extensions
   * that are actually present, so disabling this one does not fail a claim about it.
   */
  readonly wrapsToolResult?: boolean;
}

/**
 * Every extension in the suite, **in load order**.
 *
 * `package.json`'s `pi.extensions` is derived from this — the test asserts they match,
 * so adding, removing, or swapping an extension is an edit in two places that cannot
 * silently disagree.
 */
export const SURFACE: readonly ExtensionSurface[] = [
  { dir: "memory", command: "pi-memory", tools: ["memory"] },
  { dir: "plan", command: "pi-plan", tools: ["plan"] },
  { dir: "git", command: "pi-git", tools: [] },
  { dir: "spawn", command: "pi-spawn", tools: ["spawn"] },
  { dir: "browser", command: "pi-browser", tools: ["browser"] },
  // No tools: pi-telegram is a bridge, and everything it does is a hook. It used to register
  // one so the *agent* could send a message, which is the wrong direction for a messaging
  // extension — see telegram/index.ts.
  { dir: "telegram", command: "pi-telegram", tools: [] },
  { dir: "lens", command: "pi-lens", tools: ["lens"], wrapsToolResult: true },
] as const;

/** Every tool the suite exposes to the agent, across all extensions. */
export const ALL_TOOLS: readonly string[] = SURFACE.flatMap((e) => e.tools);

/** The `pi.extensions` manifest entry for an extension — the form `package.json` uses. */
export const entryPoint = (dir: string): string => `./${dir}/index.ts`;

/** The `pi.extensions` array `package.json` must declare, derived from {@link SURFACE}. */
export const MANIFEST: readonly string[] = SURFACE.map((e) => entryPoint(e.dir));
