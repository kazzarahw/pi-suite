import { test, expect } from "bun:test";
import { runConsult, type RunFn } from "../src/consult.ts";
import type { ExecFn } from "../../shared/exec.ts";

test("runConsult forwards -p prompt --model and returns trimmed stdout", async () => {
  let captured: { cmd: string; args: string[] } | undefined;
  const run: RunFn = async (cmd, args) => {
    captured = { cmd, args };
    return { stdout: "  advice here \n", stderr: "", code: 0, killed: false };
  };
  const out = await runConsult({ which: () => true, model: "opus", prompt: "why?", run , cwd: process.cwd() });
  expect(out).toBe("advice here");
  expect(captured).toEqual({ cmd: "claude", args: ["-p", "why?", "--model", "opus"] });
});

test("runConsult throws with stderr text on a non-zero exit", async () => {
  const run: RunFn = async () => ({ stdout: "", stderr: "boom", code: 2, killed: false });
  await expect(runConsult({ model: "opus", prompt: "x", run , cwd: process.cwd() })).rejects.toThrow("boom");
});

test("consult runs claude in the session's project, not the extension host's directory", async () => {
  // `claude` is itself a coding agent that reads the directory it starts in, so without
  // this the second opinion was formed from a different project's files and CLAUDE.md
  // than the question was about — while sounding perfectly authoritative.
  let seen: string | undefined;
  const run: ExecFn = async (_cmd, _args, opts) => {
    seen = opts?.cwd;
    return { stdout: "advice", stderr: "", code: 0, killed: false };
  };
  await runConsult({ which: () => true, model: "opus", prompt: "p", cwd: "/tmp/the-real-project", run });
  expect(seen).toBe("/tmp/the-real-project");
});

test("a missing claude CLI is reported as a missing CLI, not as a failed run", async () => {
  // `shared/exec.ts` always resolves, reporting a missing binary as an ordinary non-zero
  // exit — indistinguishable at this layer from a tool that ran and disagreed. Asking
  // first is what turns ENOENT into a sentence a user can act on.
  let spawned = false;
  const run: RunFn = async () => {
    spawned = true;
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  await expect(
    runConsult({ model: "opus", prompt: "p", cwd: "/tmp", run, which: () => false }),
  ).rejects.toThrow(/not on PATH/);
  expect(spawned).toBe(false);
});

test("a failed run names the model it tried", async () => {
  const run: RunFn = async () => ({ stdout: "", stderr: "unknown model", code: 1, killed: false });
  await expect(
    runConsult({ model: "some-new-model", prompt: "p", cwd: "/tmp", run, which: () => true }),
  ).rejects.toThrow(/--model some-new-model/);
});

test("a failure on the configured default points at the setting responsible", async () => {
  // A stale `defaultModel` fails every call, and the message is the only place the user
  // can learn which setting is doing it.
  const run: RunFn = async () => ({ stdout: "", stderr: "nope", code: 1, killed: false });
  const fromConfig = runConsult({
    model: "stale",
    prompt: "p",
    cwd: "/tmp",
    run,
    which: () => true,
    modelSource: "config",
  });
  await expect(fromConfig).rejects.toThrow(/\/pi-consult <model>/);

  // A model the *agent* asked for is not the user's setting, so it gets no such pointer.
  const fromParam = runConsult({
    model: "stale",
    prompt: "p",
    cwd: "/tmp",
    run,
    which: () => true,
    modelSource: "param",
  });
  await expect(fromParam).rejects.not.toThrow(/\/pi-consult <model>/);
});
