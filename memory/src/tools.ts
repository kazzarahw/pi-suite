import { Type, type Static } from "typebox";
import { relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { MEMORY_TYPES, SCOPES, type Memory, type MemoryType, type Scope } from "./frontmatter.ts";
import { listMemories, readMemory, writeMemory } from "./store.ts";
import { cwdOf, projectTrusted, type Emitter } from "../../shared/index.ts";
import { renderToolCall } from "../../shared/tool-render.ts";
import { selectByQuery, formatRecall } from "./recall.ts";
import { scanSecrets } from "./secrets.ts";

export interface MemoryToolDeps {
  recallLimit: () => number;
  emit: Emitter;
}

const ACTIONS = ["recall", "write"] as const;

const parameters = Type.Object({
  action: StringEnum(ACTIONS, {
    description: "recall (read stored memories) or write (persist a durable learning).",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "For 'recall', the exact memory name to return in full (from the injected memory index) — omit if using `query`. For 'write', the short kebab-case slug to store under; writing an existing name updates it in place.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Keywords to search memories by (name/description/body) — for 'recall'. Omit if using `name`.",
    }),
  ),
  description: Type.Optional(
    Type.String({ description: "One-line summary, used to judge relevance during recall — required for 'write'." }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "The memory body (markdown) — required for 'write'. Write what will still be true next session, not what happened in this one. Must not contain secrets.",
    }),
  ),
  type: Type.Optional(
    StringEnum(MEMORY_TYPES, {
      description:
        "Required for 'write'. feedback = a correction or a stated preference about how to work (say why); project = a fact about this repo or the work in flight; user = who they are, their role and setup; reference = a pointer to something external (URL, dashboard, ticket).",
    }),
  ),
  scope: Type.Optional(
    StringEnum(SCOPES, {
      description: "global (all projects) or project (this repo's .pi/memory) — required for 'write'.",
    }),
  ),
});
type MemoryParams = Static<typeof parameters>;

/**
 * The interesting half of a memory call, as one line: `recall auth-flow`,
 * `write api-quirks`. Pure, so the wording is testable without a terminal.
 */
export function describeCall(params: MemoryParams): string {
  const detail = params.action === "write" ? params.name : (params.name ?? params.query);
  return detail ? `${params.action} ${detail}` : params.action;
}

/**
 * `write`'s required fields, checked here rather than by the schema.
 *
 * This is what the one-tool-per-extension surface costs: `recall` and `write` need
 * disjoint fields, so each has to be optional in the schema and the provider can no
 * longer reject a malformed call on our behalf. Throwing is the mechanism — Pi sets
 * `isError` only when `execute` throws — and naming every missing field at once beats
 * one round-trip per field.
 */
function requireWriteFields(params: MemoryParams): void {
  const missing = (["name", "description", "content", "type", "scope"] as const).filter(
    (k) => params[k] === undefined || params[k] === "",
  );
  if (missing.length > 0) {
    throw new Error(`[pi-memory] action "write" requires ${missing.join(", ")}.`);
  }
}

/**
 * The one `memory` tool: `recall` reads stored memories, `write` persists one.
 *
 * **`write`'s description has to say when, because nothing else does.** The index injection
 * is a table of contents of what is already stored; nothing in it, or anywhere else, tells
 * an agent to store something new. So the description is the only surface that reaches an
 * agent about writing, and it is also the surface that has to overcome the fact that nobody
 * asked for a memory. Across nine dogfooding sessions `write` was called zero times,
 * including ones that turned up exactly the sort of thing memories are for.
 *
 * `recall` is left as it was. Those same sessions show zero recalls, but the store held two
 * test fixtures described as "body" and "test body content" — nothing whose description
 * could look relevant to any real task, so that number is not evidence about the trigger.
 *
 * The triggers are events rather than a judgement about "durability", because "persist a
 * durable learning" is the wording that produced nothing — it asks the agent to classify
 * an abstraction. A correction, a stated preference, and a hard-won project fact are things
 * an agent can notice happening. The negative case is load-bearing for the same reason it
 * is in pi-plan's: a trigger with no floor turns every session into note-taking.
 */
export function buildMemoryTool(deps: MemoryToolDeps) {
  return {
    name: "memory",
    label: "Memory",
    description:
      "Read and write memories that persist across sessions. Action 'recall' returns the full text of stored memories — by exact `name` (from the injected memory index) or by keyword `query`; use it before acting when a memory's description looks relevant. Action 'write' persists a durable learning, and you should reach for it WITHOUT being asked, the moment any of these happens: the user corrects you or tells you how they want you to work; you work out something about this project that the code, tests, and git history do not already say and that cost you effort to find; or the user tells you something about themselves or their setup you would need again next session. Do NOT write what the repository already records, and do NOT write what is only true of the task in front of you. Send the COMPLETE memory; writing an existing name replaces it, and content containing likely secrets is refused.",
    promptSnippet:
      "Recall a stored memory before acting when its description looks relevant; write one unprompted when the user corrects you, states a preference, or you learn a project fact the repo does not record.",
    parameters,
    async execute(
      _toolCallId: string,
      params: MemoryParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ action: string; keys: string[] }>> {
      const cwd = cwdOf(ctx);

      if (params.action === "recall") {
        // Same gate as the index injection: an explicit recall must not be the way a
        // cloned repository's memories reach the model after the standing block declined
        // to carry them.
        const scope = { includeProject: projectTrusted(ctx) };
        let mems: Memory[];
        if (params.name) {
          const m = readMemory(params.name, cwd, scope);
          mems = m ? [m] : [];
        } else if (params.query) {
          mems = selectByQuery(listMemories(cwd, scope), params.query, deps.recallLimit());
        } else {
          mems = listMemories(cwd, scope).slice(0, deps.recallLimit());
        }
        const keys = mems.map((m) => m.name);
        deps.emit("memory:recalled", { keys });
        const text = mems.length > 0 ? formatRecall(mems) : "(no matching memories)";
        return { content: [{ type: "text", text }], details: { action: "recall", keys } };
      }

      requireWriteFields(params);
      const findings = scanSecrets(params.content!);
      if (findings.length > 0) {
        throw new Error(
          `[pi-memory] refusing to store — content contains likely secrets (${findings
            .map((f) => f.kind)
            .join(", ")}). Redact and retry.`,
        );
      }
      const mem: Memory = {
        name: params.name!,
        description: params.description!,
        type: params.type as MemoryType,
        scope: params.scope as Scope,
        body: params.content!,
      };
      const { createdProjectDir } = writeMemory(mem, cwd);
      // Said once, on the write that creates the directory. pi-memory putting a `.pi/`
      // inside the repository is reasonable and is exactly what `project` scope means —
      // meeting it later as an unexplained untracked directory is not, particularly
      // beside pi-git's promise that nothing is written into your project.
      if (createdProjectDir && ctx?.hasUI) {
        // Relative to the project, not absolute. This is a chat notice rather than a
        // tool row, so it renders at full width with no band around it — an absolute
        // path under a long temp or worktree prefix wrapped it onto a second line and
        // made the one-time notice the loudest thing on screen. `.pi/memory` is also
        // simply the more useful answer: it is what the sentence goes on to talk about
        // adding to .gitignore.
        const where = relative(cwd, createdProjectDir) || createdProjectDir;
        ctx.ui?.notify?.(
          `[pi-memory] created ${where} for this project's memories — it lives in the repo, so add it to .gitignore if you would rather not commit it.`,
          "info",
        );
      }
      deps.emit("memory:wrote", { keys: [mem.name] });
      return {
        content: [{ type: "text", text: `Remembered "${mem.name}" (${mem.type}, ${mem.scope}).` }],
        details: { action: "write", keys: [mem.name] },
      };
    },
    renderCall(args: MemoryParams, theme: Theme, context?: { lastComponent?: unknown }) {
      return renderToolCall("memory", describeCall(args), theme, context?.lastComponent);
    },
  };
}
