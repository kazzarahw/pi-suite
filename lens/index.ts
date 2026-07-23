import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultExec } from "./src/exec.ts";
import { loadConfig, saveConfig, autodetectVerify } from "./src/config.ts";
import { createManager } from "./src/lsp/manager.ts";
import { runLinters, lintersFor } from "./src/linters.ts";
import { mergeDiagnostics, formatDiagnostics, type Diagnostic } from "./src/diagnostics.ts";
import { runVerify, formatVerify } from "./src/verify.ts";
import { buildLensTool } from "./src/tools.ts";
import { buildLensCommand } from "./src/command.ts";

const FILE_TOOLS = new Set(["read", "write", "edit"]);
const EDIT_TOOLS = new Set(["write", "edit"]);

function pathFromInput(input: unknown): string | null {
  const p = (input as { path?: string; file_path?: string } | undefined)?.path ?? (input as { file_path?: string })?.file_path;
  return typeof p === "string" ? p : null;
}

/**
 * pi-lens — real-time code feedback.
 *
 * `tool_result` on read/write/edit → gather LSP + linter diagnostics, inject a
 * `<pi-lens>` block (or emit `lens:clean`). `agent_settled` → run the verify
 * (test/build) command once edits have landed and parse cleanly, emit
 * `verify:passed`/`verify:failed`. One `lens` tool for manual LSP queries.
 *
 * Build spec: docs/superpowers/plans/2026-07-20-pi-lens.md
 */
export default function piLens(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const manager = createManager(cwd);
  let dirty = false; // an edit landed since the last verify
  let hasErrors = false; // last diagnostics had unresolved errors → don't verify yet

  pi.registerTool(buildLensTool({ manager: () => manager }));

  // Static feedback: inject diagnostics after the agent reads/writes/edits a file.
  pi.on("tool_result", async (event, ctx) => {
    if (loadConfig().mode === "off") return;
    if (!FILE_TOOLS.has(event.toolName)) return;
    const rel = pathFromInput(event.input);
    if (!rel) return;
    const file = resolve(ctx?.sessionManager?.getCwd?.() ?? cwd, rel);

    let diags: Diagnostic[] = [];
    try {
      const lsp = await manager.pull(file);
      const lint = await runLinters(file, lintersFor(file), defaultExec);
      diags = mergeDiagnostics(lsp, lint);
    } catch {
      return; // never break a read/edit because the LSP misbehaved
    }

    hasErrors = diags.some((d) => d.severity === "error");
    if (EDIT_TOOLS.has(event.toolName)) dirty = true;

    if (diags.length === 0) {
      pi.events.emit("lens:clean", { file });
      return;
    }
    pi.events.emit("lens:issues", { file, diagnostics: diags });
    const block = formatDiagnostics(rel, diags);
    return {
      content: [...event.content, { type: "text" as const, text: `\n${block}` }],
      details: event.details,
      isError: event.isError,
    };
  });

  // Dynamic feedback: run verify on settle, but only after edits landed and parse cleanly.
  pi.on("agent_settled", async (_event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off" || !dirty || hasErrors) return;
    const cmd = cfg.verifyCmd || autodetectVerify(cwd);
    if (!cmd) return;
    dirty = false;
    let result;
    try {
      result = await runVerify(cmd, defaultExec, cwd);
    } catch {
      return;
    }
    if (result.passed) pi.events.emit("verify:passed", { cmd });
    else pi.events.emit("verify:failed", { cmd, failures: result.failures });
    // Surface it to the agent — guarded on hasUI so print/JSON mode doesn't stall (see pi-todo).
    if (ctx?.hasUI) {
      pi.sendMessage({ customType: "pi-lens", content: formatVerify(result), display: true }, { deliverAs: "nextTurn" });
    }
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdownAll();
  });

  const command = buildLensCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    detectVerify: () => autodetectVerify(cwd),
  });
  pi.registerCommand(command.name, command.options);
}
