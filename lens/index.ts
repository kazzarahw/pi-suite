import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultExec } from "../shared/exec.ts";
import { cwdOf } from "../shared/index.ts";
import { loadConfig, saveConfig, autodetectVerify } from "./src/config.ts";
import { createManager } from "./src/lsp/manager.ts";
import { runLinters } from "./src/linters.ts";
import { toolchainFor, DEFAULT_TOOLCHAINS, runFormatter } from "./src/toolchains.ts";
import { discoverWarmTargets, listWorkspaceFiles } from "./src/prewarm.ts";
import { formatHealth, formatHealthCompact, probeAvailability, whichOnPath } from "./src/health.ts";
import { mergeDiagnostics, formatDiagnostics, formatFormatted, type Diagnostic } from "./src/diagnostics.ts";
import { runVerify, formatVerify, chooseVerifyCommand } from "./src/verify.ts";
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
  // No cwd is captured here. It used to be `process.cwd()` read at extension-load time
  // and passed to createManager, autodetectVerify, and runVerify — so where Pi's session
  // cwd differed, the language server was rooted in the wrong project and the verify
  // command ran in the wrong directory, for the entire session. Every site now resolves
  // `cwdOf(ctx)` from the hook that is actually firing.
  const manager = createManager();
  let dirty = false; // an edit landed since the last verify
  let hasErrors = false; // last diagnostics had unresolved errors → don't verify yet
  let warnedUntrusted = false; // the trust skip is reported once per session, not per settle

  pi.registerTool(buildLensTool({ manager: () => manager }));

  // Static feedback: inject diagnostics after the agent reads/writes/edits a file.
  pi.on("tool_result", async (event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    if (!FILE_TOOLS.has(event.toolName)) return;
    const rel = pathFromInput(event.input);
    if (!rel) return;
    const projectCwd = cwdOf(ctx);
    const file = resolve(projectCwd, rel);
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
      const lsp = await manager.pull(file, projectCwd);
      const lint = tc ? await runLinters(file, tc.linters, defaultExec, projectCwd) : [];
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
    const projectCwd = cwdOf(ctx);

    // Trust gate: an autodetected command comes out of the repository, so running it in
    // an untrusted project executes whatever that repository chose. A configured command
    // is the user's own and still runs. See chooseVerifyCommand.
    const choice = chooseVerifyCommand({
      configured: cfg.verifyCmd,
      detected: autodetectVerify(projectCwd),
      trusted: ctx?.isProjectTrusted?.() ?? true,
    });
    if (choice.run === null) {
      // Say so once. A safety gate that is invisible reads as a broken feature.
      if (choice.reason === "untrusted-autodetect" && !warnedUntrusted && ctx?.hasUI) {
        warnedUntrusted = true;
        ctx.ui?.notify?.(
          "[pi-lens] project is not trusted — skipping the autodetected verify command. Trust the project, or set one explicitly with /pi-lens.",
          "warning",
        );
      }
      return;
    }
    const cmd = choice.run;
    dirty = false;
    let result;
    try {
      result = await runVerify(cmd, defaultExec, projectCwd, ctx?.signal, cfg.verifyTimeoutMs);
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

  // Prewarm: on session start (incl. after /fork, which restarts the LSP cold), open one file per
  // present+installed language server in the background so the agent's first read/query is fast.
  // Interactive-only and best-effort — never blocks startup.
  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadConfig();
    if (!ctx?.hasUI || cfg.mode === "off" || !cfg.prewarm) return;
    const dir = cwdOf(ctx);
    try {
      const targets = discoverWarmTargets(DEFAULT_TOOLCHAINS, whichOnPath, listWorkspaceFiles(dir));
      for (const target of targets) void manager.ready(target, dir).catch(() => {});
    } catch {
      /* prewarm is best-effort */
    }
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdownAll();
  });

  const command = buildLensCommand({
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    detectVerify: (cwd: string) => autodetectVerify(cwd),
    health: () => formatHealth(probeAvailability(DEFAULT_TOOLCHAINS, whichOnPath)),
    healthCompact: () => formatHealthCompact(probeAvailability(DEFAULT_TOOLCHAINS, whichOnPath)),
  });
  pi.registerCommand(command.name, command.options);
}
