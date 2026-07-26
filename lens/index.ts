import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultExec } from "../shared/exec.ts";
import { cwdOf, projectTrusted, EDIT_TOOLS, FILE_TOOLS, editedPath } from "../shared/index.ts";
import { loadConfig, saveConfig, autodetectVerify } from "./src/config.ts";
import { createManager } from "./src/lsp/manager.ts";
import { toolchainFor, DEFAULT_TOOLCHAINS } from "./src/toolchains.ts";
import { discoverWarmTargets, listWorkspaceFiles } from "./src/prewarm.ts";
import { formatHealth, formatHealthCompact, probeAvailability, whichOnPath } from "./src/health.ts";
import { composeToolResult, feedbackBlocks, gatherFeedback } from "./src/feedback.ts";
import { createVerifyGate } from "./src/gate.ts";
import { runVerify, formatVerify, chooseVerifyCommand } from "./src/verify.ts";
import { buildLensTool } from "./src/tools.ts";
import { buildLensCommand } from "./src/command.ts";

/**
 * pi-lens — real-time code feedback.
 *
 * `tool_result` on read/write/edit → gather LSP + linter diagnostics, inject a
 * `<pi-lens>` block (or emit `lens:clean`). `agent_settled` → run the verify
 * (test/build) command once edits have landed and parse cleanly, emit
 * `verify:passed`/`verify:failed`. One `lens` tool for manual LSP queries.
 */
export default function piLens(pi: ExtensionAPI): void {
  // No cwd is captured here. It used to be `process.cwd()` read at extension-load time
  // and passed to createManager, autodetectVerify, and runVerify — so where Pi's session
  // cwd differed, the language server was rooted in the wrong project and the verify
  // command ran in the wrong directory, for the entire session. Every site now resolves
  // `cwdOf(ctx)` from the hook that is actually firing.
  const manager = createManager();
  const gate = createVerifyGate();

  pi.registerTool(buildLensTool({ manager: () => manager }));

  // Static feedback: inject diagnostics after the agent reads/writes/edits a file.
  pi.on("tool_result", async (event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    if (!FILE_TOOLS.has(event.toolName)) return;
    const rel = editedPath(event.input);
    if (!rel) return;
    const projectCwd = cwdOf(ctx);
    const file = resolve(projectCwd, rel);
    const isEdit = EDIT_TOOLS.has(event.toolName);

    const gathered = await gatherFeedback({
      file,
      rel,
      cwd: projectCwd,
      toolchain: toolchainFor(file),
      isEdit,
      autoFormat: cfg.autoFormat,
      manager,
      exec: defaultExec,
      signal: ctx?.signal,
    });

    // A language server that never answered has told us nothing. Leave the result alone
    // and leave the gate where it was: recording "no errors" here would let a verify run
    // against code nothing had checked.
    if (gathered.unavailable) return;

    gate.noteDiagnostics(gathered.diagnostics, isEdit);
    if (gathered.diagnostics.length > 0) {
      pi.events.emit("lens:issues", { file, diagnostics: gathered.diagnostics });
    } else {
      pi.events.emit("lens:clean", { file });
    }
    return composeToolResult(event, feedbackBlocks(rel, gathered));
  });

  // Dynamic feedback: run verify on settle, but only after edits landed and parse cleanly.
  pi.on("agent_settled", async (_event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off" || !gate.shouldVerify()) return;
    const projectCwd = cwdOf(ctx);

    // Trust gate: an autodetected command comes out of the repository, so running it in
    // an untrusted project executes whatever that repository chose. A configured command
    // is the user's own and still runs. See chooseVerifyCommand.
    const choice = chooseVerifyCommand({
      configured: cfg.verifyCmd,
      detected: autodetectVerify(projectCwd),
      trusted: projectTrusted(ctx),
    });
    if (choice.run === null) {
      // Say so once. A safety gate that is invisible reads as a broken feature.
      if (choice.reason === "untrusted-autodetect" && ctx?.hasUI && gate.warnOnce()) {
        ctx.ui?.notify?.(
          "[pi-lens] project is not trusted — skipping the autodetected verify command. Trust the project, or set one explicitly with /pi-lens.",
          "warning",
        );
      }
      return;
    }
    const cmd = choice.run;
    gate.consume();
    let result;
    try {
      result = await runVerify(cmd, defaultExec, projectCwd, ctx?.signal, cfg.verifyTimeoutMs);
    } catch {
      return;
    }
    // `projectCwd` travels with the event: a bus subscriber gets only `data`, so it
    // cannot resolve the cwd for itself. See shared/events.ts.
    if (result.passed) pi.events.emit("verify:passed", { cmd, cwd: projectCwd });
    else pi.events.emit("verify:failed", { cmd, failures: result.failures, cwd: projectCwd });
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
