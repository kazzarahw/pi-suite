import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { pathToFileURL } from "node:url";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LspManager } from "./lsp/manager.ts";
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
}

const fmtLocations = (locs: Location[]): string =>
  locs.length > 0 ? locs.map((l) => `${l.file}:${l.line}:${l.col}`).join("\n") : "(none found)";

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
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ action: string }>> {
      const client = await deps.manager().ready(params.path);
      if (!client) {
        throw new Error(`[pi-lens] no language server configured for ${params.path}`);
      }
      const uri = pathToFileURL(params.path).toString();
      const pos = { line: params.line, col: params.col };

      let text: string;
      switch (params.action) {
        case "hover":
          text = (await client.hover(uri, pos)) ?? "(no hover info at this position)";
          break;
        case "references":
          text = fmtLocations(await client.references(uri, pos));
          break;
        case "definition":
          text = fmtLocations(await client.definition(uri, pos));
          break;
        case "rename": {
          if (!params.new_name) {
            throw new Error(`[pi-lens] "new_name" is required for action "rename"`);
          }
          const edits = await client.rename(uri, pos, params.new_name);
          text =
            edits.length > 0
              ? `Rename touches:\n${edits.map((e) => `  ${e.file} (${(e.edits as unknown[]).length} edit(s))`).join("\n")}`
              : "(no rename edits produced)";
          break;
        }
        default:
          throw new Error(`[pi-lens] unknown action "${params.action}"`);
      }
      return { content: [{ type: "text", text }], details: { action: params.action } };
    },
  };
}
