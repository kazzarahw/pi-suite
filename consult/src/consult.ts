import { defaultExec, whichOnPath, type ExecFn } from "../../shared/exec.ts";

/** The binary pi-consult shells out to. Named once so the messages below cannot drift. */
export const CLAUDE_BIN = "claude";

/** Injectable subprocess runner, so tests never spawn a real `claude`. */
export type RunFn = ExecFn;

export interface RunConsultOptions {
  model: string;
  prompt: string;
  /**
   * The project to consult *about* — `cwdOf(ctx)`.
   *
   * Required, and not cosmetic: `claude` is itself a coding agent that reads the
   * directory it starts in. Without this it inherited the extension host's
   * `process.cwd()`, so the second opinion was formed from a different project's
   * files and CLAUDE.md than the one the question was about — while sounding
   * perfectly authoritative.
   */
  cwd: string;
  signal?: AbortSignal;
  run?: RunFn;
  /** `PATH` probe, injected so tests never depend on whether `claude` is installed. */
  which?: (bin: string) => boolean;
  /**
   * Where `model` came from. `"config"` adds the pointer to `/pi-consult` on failure —
   * a bad *configured* default fails every call, and the message is the only place the
   * user can learn which setting is responsible.
   */
  modelSource?: "param" | "config";
}

/**
 * Run `claude -p <prompt> --model <model>` in `cwd` and return the trimmed advice.
 *
 * Two failures reach a user here and both used to arrive as raw subprocess noise:
 * `claude` is not installed, and the model name is one `claude` does not know. The first
 * is answered before spawning, because `shared/exec.ts` reports a missing binary as an
 * ordinary non-zero exit — indistinguishable, at this layer, from a tool that ran and
 * disagreed. The second is answered by saying which model was tried and where it came
 * from: a stale `defaultModel` in the config file produces a failure on every call, with
 * nothing in the message connecting it to a setting the user forgot they had.
 */
export async function runConsult(opts: RunConsultOptions): Promise<string> {
  const run = opts.run ?? defaultExec;
  const which = opts.which ?? whichOnPath;
  if (!which(CLAUDE_BIN)) {
    throw new Error(
      `[pi-consult] the \`${CLAUDE_BIN}\` CLI is not on PATH, so there is no second model to ask. ` +
        `Install it (https://claude.com/claude-code) or disable pi-consult with \`pi config\`.`,
    );
  }
  const args = ["-p", opts.prompt, "--model", opts.model];
  const { stdout, stderr, code } = await run(CLAUDE_BIN, args, { cwd: opts.cwd, signal: opts.signal });
  if (code !== 0) {
    const detail = stderr.trim() || "(no stderr)";
    throw new Error(
      `[pi-consult] \`${CLAUDE_BIN} --model ${opts.model}\` exited with code ${code}: ${detail}` +
        (opts.modelSource === "config"
          ? ` — that model is the configured default; change it with \`/pi-consult <model>\`.`
          : ""),
    );
  }
  return stdout.trim();
}
