import { test, expect } from "bun:test";
import { runConsult, type RunFn } from "../src/consult.ts";

test("runConsult forwards -p prompt --model and returns trimmed stdout", async () => {
  let captured: { cmd: string; args: string[] } | undefined;
  const run: RunFn = async (cmd, args) => {
    captured = { cmd, args };
    return { stdout: "  advice here \n", stderr: "", code: 0 };
  };
  const out = await runConsult({ model: "opus", prompt: "why?", run });
  expect(out).toBe("advice here");
  expect(captured).toEqual({ cmd: "claude", args: ["-p", "why?", "--model", "opus"] });
});

test("runConsult throws with stderr text on a non-zero exit", async () => {
  const run: RunFn = async () => ({ stdout: "", stderr: "boom", code: 2 });
  await expect(runConsult({ model: "opus", prompt: "x", run })).rejects.toThrow("boom");
});
