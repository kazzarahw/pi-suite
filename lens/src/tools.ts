import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { AgentToolResult, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { LspManager } from "./lsp/manager.ts";
import { REQUEST_TIMEOUT_MS } from "./lsp/client.ts";
import { cwdOf, deadline } from "../../shared/index.ts";
import { renderToolCall } from "../../shared/tool-render.ts";
import type { Location } from "./diagnostics.ts";

const parameters = Type.Object({
  action: StringEnum(["hover", "references", "definition", "rename"], {
    description: "hover (type/docs), references (find usages), definition (jump-to), or rename (symbol).",
  }),
  path: Type.String({ description: "File path containing the symbol." }),
  line: Type.Number({ description: "1-based line number of the symbol." }),
  col: Type.Number({ description: "1-based column number of the symbol." }),
  new_name: Type.Optional(Type.String({ description: "New symbol name — required only for action 'rename'." })),
});
type LensParams = Static<typeof parameters>;

export interface LensToolDeps {
  manager: () => LspManager;
  /** Per-request deadline. Injected in tests; production uses REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Does this path exist? Injected in tests; production uses `existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * A path as the user asked for it, where that is possible.
 *
 * A language server answers in absolute `file://` URIs, so every location came back as
 * one — the call row said `definition src/greet.ts:2:17` and the result under it said
 * `/tmp/…/scratchpad/proj/src/greet.ts:2:17`, the same file twice, in two spellings, the
 * second of which wrapped. Inside the project the relative form is both shorter and the
 * one the agent can pass straight back to `read`.
 *
 * Anything *outside* the project stays absolute. A definition that landed in a
 * dependency or another checkout is exactly where the full path is the information —
 * `../../other-repo/src/x.ts` would be worse than useless.
 */
function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

const fmtLocations = (locs: Location[], cwd: string): string =>
  locs.length > 0
    ? locs.map((l) => `${displayPath(cwd, l.file)}:${l.line}:${l.col}`).join("\n")
    : "(none found)";

/**
 * The interesting half of a lens call, as one line: `hover src/foo.ts:12:5`.
 * Pure, so the wording is testable without a terminal.
 */
export function describeCall(params: LensParams): string {
  const at = params.path ? ` ${params.path}:${params.line}:${params.col}` : "";
  const to = params.action === "rename" && params.new_name ? ` → ${params.new_name}` : "";
  return `${params.action}${at}${to}`;
}

export function buildLensTool(deps: LensToolDeps) {
  return {
    name: "lens",
    label: "Lens",
    description:
      "Query the language server about a symbol at a position: hover (type + docs), references (all usages), definition (where it's defined), or rename (rename across the project). More precise than grep for code navigation.",
    promptSnippet: "Ask the language server: hover/references/definition/rename a symbol.",
    parameters,
    async execute(
      _toolCallId: string,
      params: LensParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ action: string }>> {
      // Two reasons to stop waiting — the user pressed Esc, or the server is wedged —
      // carried in one signal. This parameter was previously named `_signal` and
      // discarded, so neither worked and the only recovery was killing Pi.
      const bound = deadline(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, signal);
      const cwd = cwdOf(ctx);

      // Against the *session* cwd, not the extension host's.
      //
      // `pathToFileURL` resolves a relative path against `process.cwd()`, which is the
      // host's, and the manager takes `cwd` per call precisely because those differ —
      // see the header of `lsp/manager.ts`. So the server was rooted in the right
      // project while the URI handed to it named a file in the wrong one, and the answer
      // came back as `(none found)` or `(no hover info at this position)`: not an error,
      // just a confident nothing. It is the same defect `ExecOptions.cwd` is required to
      // prevent, and it hid in the same blind spot — resolving against `process.cwd()`
      // *by omission* matches no text, so `test/boundaries.test.ts`'s scan cannot see it.
      const abs = resolve(cwd, params.path);

      // Before the server, because a file that is not there is the more specific answer
      // and the cheaper one to establish. Without it a typo'd path reached the language
      // server, which has nothing to say about a file it cannot open, and the reply was
      // the same "(no hover info at this position)" a real symbol with no docs gets —
      // "nothing checked this" arriving as "there is nothing here".
      if (!(deps.exists ?? existsSync)(abs)) {
        throw new Error(`[pi-lens] no such file: ${params.path}`);
      }

      const client = await deps.manager().ready(abs, cwd, bound);
      if (!client) {
        throw new Error(`[pi-lens] no language server configured for ${params.path}`);
      }
      const uri = pathToFileURL(abs).toString();
      const pos = { line: params.line, col: params.col };

      // An LspUnavailableError from any of these propagates deliberately: throwing is
      // Pi's only way to set isError, and the agent must learn the server did not
      // answer rather than being handed "(none found)" as though it were a result.
      let text: string;
      switch (params.action) {
        case "hover":
          text = (await client.hover(uri, pos, bound)) ?? "(no hover info at this position)";
          break;
        case "references":
          text = fmtLocations(await client.references(uri, pos, bound), cwd);
          break;
        case "definition":
          text = fmtLocations(await client.definition(uri, pos, bound), cwd);
          break;
        case "rename": {
          if (!params.new_name) {
            throw new Error(`[pi-lens] "new_name" is required for action "rename"`);
          }
          const edits = await client.rename(uri, pos, params.new_name, bound);
          text =
            edits.length > 0
              ? `Rename touches:\n${edits.map((e) => `  ${displayPath(cwd, e.file)} (${(e.edits as unknown[]).length} edit(s))`).join("\n")}`
              : "(no rename edits produced)";
          break;
        }
        default:
          throw new Error(`[pi-lens] unknown action "${params.action}"`);
      }
      return { content: [{ type: "text", text }], details: { action: params.action } };
    },
    renderCall(args: LensParams, theme: Theme, context?: { lastComponent?: unknown }) {
      return renderToolCall("lens", describeCall(args), theme, context?.lastComponent);
    },
  };
}
