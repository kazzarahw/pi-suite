import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultExec } from "../shared/exec.ts";
import {
  cwdOf,
  createNudgeGuard,
  projectTrusted,
  EDIT_TOOLS,
  FILE_TOOLS,
  editedPath,
} from "../shared/index.ts";
import { formatStandingContext, summarizeForStatus } from "./src/diagnostics.ts";
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
  // Bounds `block` mode's auto-continue, exactly as pi-todo and pi-goal bound theirs: the
  // agent that broke the tests may never fix them, and "keep going until green" has no
  // exit condition of its own.
  const guard = createNudgeGuard();

  pi.registerTool(buildLensTool({ manager: () => manager }));

  /**
   * The verify command this project would run, or `null`. Shared by the standing context
   * and the settle hook so the two can never disagree about what "automatically" means.
   */
  const verifyChoiceFor = (ctx: Parameters<typeof cwdOf>[0] & { isProjectTrusted?: () => boolean }) =>
    chooseVerifyCommand({
      configured: loadConfig().verifyCmd,
      detected: autodetectVerify(cwdOf(ctx)),
      trusted: projectTrusted(ctx),
    });

  /**
   * Standing context: tell the agent pi-lens is running.
   *
   * Everything else here is *reactive* — a block appended to a tool result the agent has
   * already received. None of it says the feedback is automatic, so an agent with no
   * standing knowledge of pi-lens assumes nothing is checking and runs the type-checker
   * itself. Ephemeral and prepended per call, the same shape pi-memory uses for its index.
   */
  pi.on("context", async (event, ctx) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const choice = verifyChoiceFor(ctx);
    const block = formatStandingContext(choice.run);
    return {
      messages: [{ role: "user" as const, content: block, timestamp: Date.now() }, ...event.messages],
    };
  });

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

    if (gathered.unavailable) {
      // A language server that never answered has told us nothing. The gate stays where
      // it was — recording "no errors" here would let a verify run against code nothing
      // had checked — and neither `lens:clean` nor `lens:issues` is true, so neither is
      // emitted.
      //
      // The result is still rewritten, which it did not used to be. Returning early threw
      // away the whole `Gathered`, including a reformat note the formatter had already
      // earned: it runs before the pull and fails independently of it, so the file could
      // be rewritten on disk with the agent never told. And since the standing context
      // now promises that silence means clean, silence on this path would be a lie.
      ctx?.ui?.setStatus?.("lens", `lens: could not check ${rel.split("/").pop() || rel}`);
      return composeToolResult(event, feedbackBlocks(rel, gathered));
    }

    gate.noteDiagnostics(gathered.diagnostics, isEdit);
    // Show the user what the agent was just told. The `<pi-lens>` block below goes into
    // the tool result, which Pi renders with its own built-in renderer — a diff for an
    // edit, file content for a read — so the appended text is never drawn on screen.
    ctx?.ui?.setStatus?.("lens", summarizeForStatus(rel, gathered.diagnostics));
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
    const choice = verifyChoiceFor(ctx);
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

    // Everything below is guarded on hasUI: in print/JSON one-shot mode there is no next
    // prompt, so a queued message stalls Pi's exit waiting for one (see pi-todo).
    if (!ctx?.hasUI) return;

    // The user, now. `deliverAs` only ever reaches the *agent*, and a queued message is
    // not drawn until it is delivered — so on the turn that broke the build, the user saw
    // the agent say "done" and nothing else. This is the channel that fires at settle.
    ctx.ui?.notify?.(
      result.passed
        ? `[pi-lens] ${cmd} passed.`
        : `[pi-lens] ${cmd} FAILED${result.failures.length > 0 ? `: ${result.failures.slice(0, 3).join(", ")}` : ""}`,
      result.passed ? "info" : "warning",
    );

    // A passing verify needs nothing from the agent. Saying so anyway spends a turn's
    // attention to report that nothing happened.
    if (result.passed) {
      guard.reset();
      return;
    }

    // The agent. `display: false` because the notify above already reached the user, and
    // rendering the same failure twice trains them to ignore both.
    const send = (insist: boolean) => ({
      customType: "pi-lens",
      content: formatVerify(result, { insist }),
      display: false,
    });

    if (cfg.mode === "block") {
      // Insist: deliver as a follow-up and trigger a turn, so the failure is acted on in
      // the same breath as the edit that caused it. Bounded on the failure set — an
      // unchanged one means the last continue achieved nothing.
      //
      // `insist: true` because triggering a turn only buys attention, not action: the
      // first live run of this auto-continued and then asked whether it should look into
      // the failure. A block-mode message has to state what it wants.
      if (!guard.allow(result.failures.join("|"), 2)) return;
      pi.sendMessage(send(true), { deliverAs: "followUp", triggerTurn: true });
      return;
    }

    // notify: never compels a turn. The failure reaches the agent with the user's next
    // message, which is the contract for this mode — the user has already been told.
    pi.sendMessage(send(false), { deliverAs: "nextTurn" });
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
