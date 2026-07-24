import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConsultConfig } from "./config.ts";

const parameters = Type.Object({
  prompt: Type.String({
    description: "The question or context to send to the consulting model.",
  }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional claude model/alias to consult (e.g. "opus", "sonnet"). Defaults to the configured default model.',
    }),
  ),
});
type ConsultParams = Static<typeof parameters>;

/** Dependencies the tool reads at call time. `ctx.ui` is NOT here — it comes from the execute `ctx`. */
export interface ToolDeps {
  loadConfig: () => ConsultConfig;
  runConsult: (o: { model: string; prompt: string; signal?: AbortSignal }) => Promise<string>;
  emit: (event: string, data: unknown) => void;
}

/** Build the `consult` tool definition for `pi.registerTool`. */
export function buildConsultTool(deps: ToolDeps) {
  return {
    name: "consult",
    label: "Consult",
    description:
      "Ask a second, independent model (via the `claude` CLI) for read-only advice on a hard problem, plan, or review. Returns the advice as text and makes no changes.",
    promptSnippet: "Get a second opinion from another model on a hard problem, plan, or review.",
    parameters,
    async execute(
      _toolCallId: string,
      params: ConsultParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ model: string }>> {
      const cfg = deps.loadConfig();
      const model = params.model?.trim() || cfg.defaultModel;
      ctx?.ui?.setStatus?.("consult", `consulting ${model}…`);
      try {
        const advice = await deps.runConsult({ model, prompt: params.prompt, signal });
        deps.emit("consult:answered", { model, topic: params.prompt.slice(0, 80) });
        return { content: [{ type: "text", text: advice }], details: { model } };
      } finally {
        ctx?.ui?.setStatus?.("consult", undefined);
      }
    },
  };
}
