import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConsultConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => ConsultConfig;
  saveConfig: (c: ConsultConfig) => void;
}

/**
 * Build the `/pi-consult` config command: no arg reports the default model,
 * `/pi-consult <model>` sets it. (The spec's `argumentHint` isn't a real
 * RegisteredCommand field; `getArgumentCompletions` is the API equivalent.)
 */
export function buildConsultCommand(deps: CommandDeps) {
  return {
    name: "pi-consult" as const,
    options: {
      description: "View or set the default model pi-consult uses.",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
        const items = deps
          .loadConfig()
          .allowedModels.filter((m) => m.startsWith(argumentPrefix))
          .map((m) => ({ value: m, label: m }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const model = args.trim();
        const cfg = deps.loadConfig();
        if (!model) {
          ctx?.ui?.notify?.(`[pi-consult] default model: ${cfg.defaultModel}`, "info");
          return;
        }
        deps.saveConfig({ ...cfg, defaultModel: model });
        ctx?.ui?.notify?.(`[pi-consult] default model set to: ${model}`, "info");
      },
    },
  };
}
