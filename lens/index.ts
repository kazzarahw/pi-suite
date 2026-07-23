import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultExec } from "./src/exec.ts";
import { loadConfig, saveConfig, autodetectVerify } from "./src/config.ts";
import { createManager } from "./src/lsp/manager.ts";
import { runLinters } from "./src/linters.ts";
import { toolchainFor, DEFAULT_TOOLCHAINS, runFormatter } from "./src/toolchains.ts";
import { formatHealth, formatHealthCompact, probeAvailability, whichOnPath } from "./src/health.ts";
import { mergeDiagnostics, formatDiagnostics, formatFormatted, type Diagnostic } from "./src/diagnostics.ts";
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
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    if (!FILE_TOOLS.has(event.toolName)) return;
    const rel = pathFromInput(event.input);
    if (!rel) return;
    const file = resolve(ctx?.sessionManager?.getCwd?.() ?? cwd, rel);
    const tc = toolchainFor(file);
    const isEdit = EDIT_TOOLS.has(event.toolName);

    // Opt-in auto-format runs first (write/edit only) so diagnostics reflect the formatted bytes.
    let reformatNote = "";
    if (isEdit && cfg.autoFormat && tc?.formatter) {
      try {
        if ((await runFormatter(file, tc.formatter, defaultExec, ctx?.signal)).changed) {
          reformatNote = formatFormatted(rel, tc.formatter.name);
        }
      } catch {
        /* never break an edit because the formatter misbehaved */
      }
    }

    let diags: Diagnostic[] = [];
    try {
      const lsp = await manager.pull(file);
      const lint = tc ? await runLinters(file, tc.linters, defaultExec) : [];
      diags = mergeDiagnostics(lsp, lint);
    } catch {
      return; // never break a read/edit because the LSP misbehaved
    }

    hasErrors = diags.some((d) => d.severity === "error");
    if (isEdit) dirty = true;

    // Compose the injection: a diagnostics block (or lens:clean), plus a reformat note when formatted.
    const blocks: string[] = [];
    if (diags.length > 0) {
      pi.events.emit("lens:issues", { file, diagnostics: diags });
      blocks.push(formatDiagnostics(rel, diags));
    } else {
      pi.events.emit("lens:clean", { file });
    }
    if (reformatNote) blocks.push(reformatNote);
    if (blocks.length === 0) return;
    return {
      content: [...event.content, { type: "text" as const, text: `\n${blocks.join("\n")}` }],
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
    health: () => formatHealth(probeAvailability(DEFAULT_TOOLCHAINS, whichOnPath)),
    healthCompact: () => formatHealthCompact(probeAvailability(DEFAULT_TOOLCHAINS, whichOnPath)),
  });
  pi.registerCommand(command.name, command.options);
}
