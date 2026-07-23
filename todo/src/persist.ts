import type { TodoItem } from "pi-shared";

/** Custom-entry type used to persist todo state in the session (not sent to the LLM). */
const ENTRY_TYPE = "todo-state";

interface AppendCapable {
  appendEntry: (customType: string, data?: unknown) => void;
}

interface BranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}
interface RestoreCtx {
  sessionManager?: { getBranch: () => BranchEntry[] } | null;
}

/** Persist the current list as a `todo-state` custom entry. */
export function appendState(pi: AppendCapable, todos: TodoItem[]): void {
  pi.appendEntry(ENTRY_TYPE, { todos });
}

/** Rebuild the list from the most recent `todo-state` entry in the branch, or `[]`. */
export function restoreState(ctx: RestoreCtx): TodoItem[] {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry && entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      const data = entry.data as { todos?: TodoItem[] } | undefined;
      return Array.isArray(data?.todos) ? data.todos : [];
    }
  }
  return [];
}
