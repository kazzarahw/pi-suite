import { MODES } from "../../shared/index.ts";
import { defineConfigCommand, enumField, type Field } from "../../shared/config-command.ts";
import type { TodoConfig } from "./config.ts";

export interface CommandDeps {
  loadConfig: () => TodoConfig;
  saveConfig: (c: TodoConfig) => void;
}

export const FIELDS: readonly Field<TodoConfig>[] = [enumField("mode", MODES, "Nudge mode")];

/** `/pi-todo` — no arg opens the settings panel; `/pi-todo <off|notify|block>` sets the nudge mode. */
export function buildTodoCommand(deps: CommandDeps) {
  return defineConfigCommand("todo", FIELDS, deps, {
    subtitle: "when to remind about open todos",
    bareValueField: "mode",
  });
}
