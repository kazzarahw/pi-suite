import { test, expect } from "bun:test";
import { defaultExec } from "../src/exec.ts";

/** Reject if a promise doesn't settle within `ms` — turns a hang into a clear failure. */
const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`did not settle within ${ms}ms`)), ms)),
  ]);

test("defaultExec captures stdout and exit 0 for a successful command", async () => {
  const r = await defaultExec("sh", ["-c", "printf hello"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("hello");
});

test("defaultExec propagates a non-zero exit code", async () => {
  expect((await defaultExec("sh", ["-c", "exit 7"])).code).toBe(7);
});

// The guarantee the LSP-hang fix leans on: a missing binary must RESOLVE (code != 0),
// never hang — unlike the hand-rolled LSP request(). Locks it against a future regression.
test("defaultExec resolves promptly on a missing binary (never hangs)", async () => {
  const r = await within(2000, defaultExec("pi-lens-definitely-not-a-real-binary", ["--x"]));
  expect(r.code).not.toBe(0);
});
