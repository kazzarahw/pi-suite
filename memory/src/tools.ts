import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MEMORY_TYPES, SCOPES, type Memory, type MemoryType, type Scope } from "./frontmatter.ts";
import { listMemories, readMemory, writeMemory } from "./store.ts";
import { selectByQuery, formatRecall } from "./recall.ts";
import { scanSecrets } from "./secrets.ts";

export interface MemoryToolDeps {
  recallLimit: () => number;
  emit: (event: string, data: unknown) => void;
}

const cwdOf = (ctx: ExtensionContext): string => ctx?.sessionManager?.getCwd?.() ?? process.cwd();

const recallParameters = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Keywords to search memories by (name/description/body). Omit if using `name`." }),
  ),
  name: Type.Optional(
    Type.String({ description: "Exact memory name to recall its full text. Omit if using `query`." }),
  ),
});
type RecallParams = Static<typeof recallParameters>;

/** memory_recall — return full memory bodies by name or keyword query. */
export function buildRecallTool(deps: MemoryToolDeps) {
  return {
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Recall the full text of stored memories — by exact `name` (from the injected memory index) or by keyword `query`. Use it before acting when a memory's description looks relevant.",
    promptSnippet: "Recall a stored memory's full text by name or keyword.",
    parameters: recallParameters,
    async execute(
      _toolCallId: string,
      params: RecallParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ keys: string[] }>> {
      const cwd = cwdOf(ctx);
      let mems: Memory[];
      if (params.name) {
        const m = readMemory(params.name, cwd);
        mems = m ? [m] : [];
      } else if (params.query) {
        mems = selectByQuery(listMemories(cwd), params.query, deps.recallLimit());
      } else {
        mems = listMemories(cwd).slice(0, deps.recallLimit());
      }
      const keys = mems.map((m) => m.name);
      deps.emit("memory:recalled", { keys });
      const text = mems.length > 0 ? formatRecall(mems) : "(no matching memories)";
      return { content: [{ type: "text", text }], details: { keys } };
    },
  };
}

const writeParameters = Type.Object({
  name: Type.String({
    description: "Short kebab-case slug identifying this memory. Writing an existing name updates it in place.",
  }),
  description: Type.String({ description: "One-line summary — used to judge relevance during recall." }),
  content: Type.String({ description: "The memory body (markdown). Must not contain secrets." }),
  type: StringEnum(MEMORY_TYPES, { description: "user | feedback | project | reference." }),
  scope: StringEnum(SCOPES, { description: "global (all projects) or project (this repo's .pi/memory)." }),
});
type WriteParams = Static<typeof writeParameters>;

/** memory_write — persist a durable learning; refuses content containing likely secrets. */
export function buildWriteTool(deps: MemoryToolDeps) {
  return {
    name: "memory_write",
    label: "Memory Write",
    description:
      "Persist a durable learning across sessions (a user preference, a correction, a project fact, a reference). Send the COMPLETE memory; writing an existing name replaces it. Refuses content containing secrets.",
    promptSnippet: "Remember a durable fact/preference/correction across sessions.",
    parameters: writeParameters,
    async execute(
      _toolCallId: string,
      params: WriteParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ keys: string[] }>> {
      const findings = scanSecrets(params.content);
      if (findings.length > 0) {
        throw new Error(
          `[pi-memory] refusing to store — content contains likely secrets (${findings
            .map((f) => f.kind)
            .join(", ")}). Redact and retry.`,
        );
      }
      const mem: Memory = {
        name: params.name,
        description: params.description,
        type: params.type as MemoryType,
        scope: params.scope as Scope,
        body: params.content,
      };
      writeMemory(mem, cwdOf(ctx));
      deps.emit("memory:wrote", { keys: [params.name] });
      return {
        content: [{ type: "text", text: `Remembered "${params.name}" (${mem.type}, ${mem.scope}).` }],
        details: { keys: [params.name] },
      };
    },
  };
}
