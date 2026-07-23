import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.ts";
import { listMemories, deleteMemory, writeMemory } from "./src/store.ts";
import { formatIndexInjection } from "./src/recall.ts";
import { scanSecrets } from "./src/secrets.ts";
import { buildRecallTool, buildWriteTool } from "./src/tools.ts";
import { buildMemoryCommand } from "./src/command.ts";

/**
 * pi-memory — persistent, write-back memory.
 *
 * Registers `memory_recall` / `memory_write`, injects the memory *index* into
 * every LLM call (progressive disclosure — bodies load on recall), and can
 * auto-capture a gotcha on `verify:failed`. Emits `memory:wrote` / `memory:recalled`.
 *
 * Build spec: docs/superpowers/plans/2026-07-20-pi-memory.md
 */
export default function piMemory(pi: ExtensionAPI): void {
  const emit = (event: string, data: unknown) => pi.events.emit(event, data);

  pi.registerTool(buildRecallTool({ recallLimit: () => loadConfig().recallLimit, emit }));
  pi.registerTool(buildWriteTool({ recallLimit: () => loadConfig().recallLimit, emit }));

  // Standing context: inject the memory index into each LLM call (ephemeral — the
  // house-style §6 channel for memory recall; no queued message, so no print-mode hang).
  pi.on("context", async (event, ctx) => {
    if (loadConfig().mode === "off") return;
    const cwd = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
    const block = formatIndexInjection(listMemories(cwd));
    if (!block) return;
    const injected = { role: "user" as const, content: block, timestamp: Date.now() };
    return { messages: [injected, ...event.messages] };
  });

  // Auto-capture a gotcha on verify:failed (opt-in; naive capture is noisy, so off by default).
  pi.events.on("verify:failed", (data) => {
    const cfg = loadConfig();
    if (cfg.mode === "off" || !cfg.autoCapture) return;
    const d = (data ?? {}) as { cmd?: string; failures?: string[] };
    const failures = (d.failures ?? []).slice(0, 5);
    if (failures.length === 0) return;
    const body = `Command: ${d.cmd ?? "(unknown)"}\nFailures:\n${failures.map((f) => `- ${f}`).join("\n")}`;
    if (scanSecrets(body).length > 0) return;
    const key = `gotcha-verify-${hash(`${d.cmd}:${failures.join("|")}`)}`;
    try {
      writeMemory(
        { name: key, description: `verify failed: ${d.cmd ?? "tests"}`, type: "project", scope: "project", body },
        process.cwd(),
      );
      emit("memory:wrote", { keys: [key] });
    } catch {
      /* ignore (e.g. write race) */
    }
  });

  const command = buildMemoryCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    listMemories: () => listMemories(process.cwd()),
    deleteMemory: (name) => deleteMemory(name, process.cwd()),
  });
  pi.registerCommand(command.name, command.options);
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
