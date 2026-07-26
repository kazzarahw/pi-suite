import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.ts";
import { listMemories, deleteMemory, writeMemory, ALL_SCOPES } from "./src/store.ts";
import { formatIndexInjection } from "./src/recall.ts";
import { scanSecrets } from "./src/secrets.ts";
import { buildRecallTool, buildWriteTool } from "./src/tools.ts";
import { buildMemoryCommand } from "./src/command.ts";
import { cwdOf, projectTrusted, stableHash, type Emitter } from "../shared/index.ts";

/**
 * pi-memory — persistent, write-back memory.
 *
 * Registers `memory_recall` / `memory_write`, injects the memory *index* into
 * every LLM call (progressive disclosure — bodies load on recall), and can
 * auto-capture a gotcha on `verify:failed`. Emits `memory:wrote` / `memory:recalled`.
 */
export default function piMemory(pi: ExtensionAPI): void {
  const emit: Emitter = (event, data) => pi.events.emit(event, data);

  pi.registerTool(buildRecallTool({ recallLimit: () => loadConfig().recallLimit, emit }));
  pi.registerTool(buildWriteTool({ recallLimit: () => loadConfig().recallLimit, emit }));

  // Standing context: inject the memory index into each LLM call (ephemeral — the
  // context-injection channel for recall; no queued message, so no print-mode hang).
  pi.on("context", async (event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    // `<cwd>/.pi/memory` is repository content, and this block is prepended to every
    // LLM call — so an untrusted project does not get to write the agent's standing
    // context. Same line pi-lens draws around an autodetected verify command.
    const scope = { includeProject: projectTrusted(ctx) };
    const block = formatIndexInjection(listMemories(cwdOf(ctx), scope), cfg.indexLimit);
    if (!block) return;
    const injected = { role: "user" as const, content: block, timestamp: Date.now() };
    return { messages: [injected, ...event.messages] };
  });

  // Auto-capture a gotcha on verify:failed (opt-in; naive capture is noisy, so off by default).
  //
  // Everything this needs arrives in the payload, `cwd` included. It used to keep a
  // module-level latch of the last cwd seen from the `context` hook, because a bus
  // callback gets no ExtensionContext — which meant the handler's correctness depended
  // on an unrelated hook having fired first, and on nothing between them changing
  // directory. It also means this works against any publisher of `verify:failed`, not
  // only pi-lens.
  pi.events.on("verify:failed", (data) => {
    const cfg = loadConfig();
    if (cfg.mode === "off" || !cfg.autoCapture) return;
    const d = (data ?? {}) as { cmd?: string; failures?: string[]; cwd?: string };
    // A payload with no cwd is one this handler cannot attribute to a project. Skipping
    // beats guessing and writing the memory into the wrong repository.
    if (!d.cwd) return;
    const failures = (d.failures ?? []).slice(0, 5);
    if (failures.length === 0) return;
    const body = `Command: ${d.cmd ?? "(unknown)"}\nFailures:\n${failures.map((f) => `- ${f}`).join("\n")}`;
    if (scanSecrets(body).length > 0) return;
    const key = `gotcha-verify-${stableHash(`${d.cmd}:${failures.join("|")}`)}`;
    try {
      writeMemory(
        { name: key, description: `verify failed: ${d.cmd ?? "tests"}`, type: "project", scope: "project", body },
        d.cwd,
      );
      emit("memory:wrote", { keys: [key] });
    } catch {
      /* ignore (e.g. write race) */
    }
  });

  const command = buildMemoryCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    // Deliberately unscoped. Trust governs what reaches the *model*; it does not hide
    // the user's own files from the user, and `/pi-memory delete <name>` has to be able
    // to name a project memory in a project the user has not trusted.
    listMemories: (cwd: string) => listMemories(cwd, ALL_SCOPES),
    deleteMemory: (name: string, cwd: string) => deleteMemory(name, cwd),
  });
  pi.registerCommand(command.name, command.options);
}
