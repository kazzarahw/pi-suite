/**
 * Gathering post-edit feedback, and composing it into a tool result.
 *
 * This was the body of the `tool_result` hook: format the file, pull LSP diagnostics,
 * run the linters, merge, decide what to emit, and rebuild the result — eight concerns
 * in one function, each reachable only by driving the hook with a fake context. Split so
 * the I/O half takes its dependencies as arguments and the composing half is pure.
 */
import { runLinters } from "./linters.ts";
import { whichOnPath } from "./health.ts";
import { runFormatter, type LanguageToolchain } from "./toolchains.ts";
import {
  mergeDiagnostics,
  formatDiagnostics,
  formatFormatted,
  formatUnavailable,
  type Diagnostic,
} from "./diagnostics.ts";
import type { ExecFn } from "../../shared/exec.ts";
import type { LspManager } from "./lsp/manager.ts";

export interface GatherInput {
  /** Absolute path of the file the tool touched. */
  file: string;
  /** The path as the agent wrote it — what the injection shows. */
  rel: string;
  /** Project root: where language servers are rooted and linters run. */
  cwd: string;
  toolchain: LanguageToolchain | null;
  /** Whether the tool changed the file (write/edit) rather than only reading it. */
  isEdit: boolean;
  autoFormat: boolean;
  manager: LspManager;
  exec: ExecFn;
  signal?: AbortSignal;
  /** `PATH` probe, injected for tests. Decides whether a linter could have run at all. */
  which?: (bin: string) => boolean;
}

export interface Gathered {
  diagnostics: Diagnostic[];
  /** A `<pi-lens>` note that the file was reformatted, or `""`. */
  reformatNote: string;
  /**
   * True when nothing actually checked this file. Distinct from an empty list, which
   * means "checked, and clean": reporting the first as the second tells the agent its
   * code is fine when nothing looked at it.
   *
   * Two ways to get here, treated alike because they are indistinguishable downstream:
   * the language server was reached and misbehaved, or there was never one to reach.
   * The second is the common case and was the quieter bug — `manager.pull` returns `[]`
   * for a language whose server is not installed, and its own comment noted that for
   * diagnostics an unavailable server and a clean file "are the same outcome". They were,
   * until the standing context began telling the agent that silence means clean. Writing
   * Go on a machine with no gopls then produced a confident all-clear from nothing.
   */
  unavailable: boolean;
}

/**
 * Format (opt-in), then gather LSP + linter diagnostics.
 *
 * Formatting runs first so the diagnostics describe the bytes now on disk rather than
 * the ones the agent wrote. Neither half may throw: a misbehaving formatter or language
 * server must not break the edit that triggered it.
 */
export async function gatherFeedback(input: GatherInput): Promise<Gathered> {
  const { file, rel, cwd, toolchain, isEdit, autoFormat, manager, exec, signal } = input;
  const which = input.which ?? whichOnPath;

  let reformatNote = "";
  if (isEdit && autoFormat && toolchain?.formatter) {
    try {
      if ((await runFormatter(file, toolchain.formatter, exec, cwd, signal)).changed) {
        reformatNote = formatFormatted(rel, toolchain.formatter.name);
      }
    } catch {
      /* never break an edit because the formatter misbehaved */
    }
  }

  try {
    // Asked first, and separately from `pull`, because the answer is the difference
    // between "clean" and "nobody looked". `ready` is memoized per (cwd, command), so the
    // second resolution inside `pull` is free.
    const client = await manager.ready(file, cwd, signal).catch(() => null);
    const lsp = client ? await manager.pull(file, cwd) : [];

    // The same filter `runLinters` applies, plus a PATH probe: a linter that is disabled
    // for this project, or simply not installed, did not check anything. Mirrored rather
    // than returned by `runLinters` because that function reports diagnostics only — a
    // missing binary and a clean file both reach it as an empty list.
    const linters = (toolchain?.linters ?? []).filter(
      (spec) => (!spec.enabledFor || spec.enabledFor(cwd)) && which(spec.cmd("x")[0] ?? ""),
    );
    const lint = toolchain ? await runLinters(file, toolchain.linters, exec, cwd) : [];

    return {
      diagnostics: mergeDiagnostics(lsp, lint),
      reformatNote,
      unavailable: client === null && linters.length === 0,
    };
  } catch {
    return { diagnostics: [], reformatNote, unavailable: true };
  }
}

/**
 * The `<pi-lens>` blocks to append, in order. Pure.
 *
 * Empty when there is nothing to say — the caller returns the tool result untouched
 * rather than appending a blank line to every read.
 */
export function feedbackBlocks(rel: string, gathered: Gathered): string[] {
  const blocks: string[] = [];
  if (gathered.unavailable) blocks.push(formatUnavailable(rel));
  else if (gathered.diagnostics.length > 0) blocks.push(formatDiagnostics(rel, gathered.diagnostics));
  // Outside the branch on purpose. Formatting runs *before* the diagnostics pull and
  // succeeds or fails independently of it, so a wedged language server does not mean the
  // file is unchanged — the note used to be dropped along with everything else on that
  // path, leaving the agent working from a copy the formatter had already rewritten.
  if (gathered.reformatNote) blocks.push(gathered.reformatNote);
  return blocks;
}

/** A text part, the only kind this appends. */
export interface TextPart {
  type: "text";
  text: string;
}

/**
 * The subset of a `tool_result` event this rebuilds.
 *
 * Generic over the content element so Pi's own union (`TextContent | ImageContent`)
 * passes through unwidened — a `{ type: string; [k: string]: unknown }` shape would have
 * been assignable *from* nothing Pi actually produces.
 */
export interface ToolResultLike<C> {
  content: readonly C[];
  details?: unknown;
  isError?: boolean;
}

/**
 * Append the feedback blocks to a tool result. Pure.
 *
 * Returns `undefined` when there is nothing to add, which is the hook's signal to leave
 * the result exactly as the tool produced it — not an empty trailing line on every read.
 */
export function composeToolResult<C>(
  event: ToolResultLike<C>,
  blocks: readonly string[],
): { content: (C | TextPart)[]; details?: unknown; isError?: boolean } | undefined {
  if (blocks.length === 0) return undefined;
  return {
    content: [...event.content, { type: "text", text: `\n${blocks.join("\n")}` }],
    details: event.details,
    isError: event.isError,
  };
}
