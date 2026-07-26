import { test, expect } from "bun:test";
import { runConsult, type RunFn } from "../src/consult.ts";
import type { ExecFn } from "../../shared/exec.ts";

test("runConsult forwards -p prompt --model and returns trimmed stdout", async () => {
  let captured: { cmd: string; args: string[] } | undefined;
  const run: RunFn = async (cmd, args) => {
    captured = { cmd, args };
    return { stdout: "  advice here \n", stderr: "", code: 0, killed: false };
  };
  const out = await runConsult({ model: "opus", prompt: "why?", run , cwd: process.cwd() });
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
  await runConsult({ model: "opus", prompt: "p", cwd: "/tmp/the-real-project", run });
  expect(seen).toBe("/tmp/the-real-project");
});
