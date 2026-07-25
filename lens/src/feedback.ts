/**
 * Gathering post-edit feedback, and composing it into a tool result.
 *
 * This was the body of the `tool_result` hook: format the file, pull LSP diagnostics,
 * run the linters, merge, decide what to emit, and rebuild the result — eight concerns
 * in one function, each reachable only by driving the hook with a fake context. Split so
 * the I/O half takes its dependencies as arguments and the composing half is pure.
 */
import { runLinters } from "./linters.ts";
import { runFormatter, type LanguageToolchain } from "./toolchains.ts";
import { mergeDiagnostics, formatDiagnostics, formatFormatted, type Diagnostic } from "./diagnostics.ts";
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
}

export interface Gathered {
  diagnostics: Diagnostic[];
  /** A `<pi-lens>` note that the file was reformatted, or `""`. */
  reformatNote: string;
  /**
   * True when diagnostics could not be gathered at all — a wedged or crashed language
   * server. Distinct from an empty list, which means "checked, and clean": reporting the
   * first as the second would tell the agent its code is fine when nothing looked at it.
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

  let reformatNote = "";
  if (isEdit && autoFormat && toolchain?.formatter) {
    try {
      if ((await runFormatter(file, toolchain.formatter, exec, signal)).changed) {
        reformatNote = formatFormatted(rel, toolchain.formatter.name);
      }
    } catch {
      /* never break an edit because the formatter misbehaved */
    }
  }

  try {
    const lsp = await manager.pull(file, cwd);
    const lint = toolchain ? await runLinters(file, toolchain.linters, exec, cwd) : [];
    return { diagnostics: mergeDiagnostics(lsp, lint), reformatNote, unavailable: false };
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
  if (gathered.diagnostics.length > 0) blocks.push(formatDiagnostics(rel, gathered.diagnostics));
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
