import { test, expect } from "bun:test";
import { defaultExec, MAX_BUFFER } from "../exec.ts";
import { within } from "./harness.ts";

test("defaultExec captures stdout and exit 0 for a successful command", async () => {
  const r = await defaultExec("sh", ["-c", "printf hello"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("hello");
});

test("defaultExec propagates a non-zero exit code", async () => {
  expect((await defaultExec("sh", ["-c", "exit 7"])).code).toBe(7);
});

test("defaultExec captures stderr alongside a non-zero exit", async () => {
  const r = await defaultExec("sh", ["-c", "printf boom >&2; exit 3"]);
  expect(r.code).toBe(3);
  expect(r.stderr).toContain("boom");
});

// The guarantee the LSP-hang fix leans on: a missing binary must RESOLVE (code != 0),
// never hang — unlike the hand-rolled LSP request(). Locks it against a future regression.
test("defaultExec resolves promptly on a missing binary (never hangs)", async () => {
  const r = await within(2000, defaultExec("pi-suite-definitely-not-a-real-binary", ["--x"]));
  expect(r.code).not.toBe(0);
});

// Carried over from pi-browser: when a spawn fails with no stderr (e.g. ENOENT), surface
// the error message rather than an empty string, so callers can report something useful.
test("defaultExec falls back to the error message when stderr is empty", async () => {
  const r = await defaultExec("pi-suite-definitely-not-a-real-binary", []);
  expect(r.stderr.length).toBeGreaterThan(0);
});

// Carried over from pi-lens: the working directory must be honored.
test("defaultExec honors cwd", async () => {
  const r = await defaultExec("sh", ["-c", "pwd"], { cwd: "/tmp" });
  expect(r.stdout.trim()).toBe("/tmp");
});

// Carried over from pi-git: extra env is merged OVER process.env, not replacing it.
test("defaultExec merges env over process.env rather than replacing it", async () => {
  const r = await defaultExec("sh", ["-c", "printf '%s|%s' \"$PI_SUITE_TEST_VAR\" \"$HOME\""], {
    env: { PI_SUITE_TEST_VAR: "set-by-test" },
  });
  const [custom, home] = r.stdout.split("|");
  expect(custom).toBe("set-by-test");
  expect(home).toBe(process.env.HOME);
});

test("defaultExec settles rather than hanging when the signal is already aborted", async () => {
  const r = await within(2000, defaultExec("sh", ["-c", "sleep 5"], { signal: AbortSignal.abort() }));
  expect(r.code).not.toBe(0);
});

test("defaultExec settles when the signal aborts mid-flight", async () => {
  const ac = new AbortController();
  const p = defaultExec("sh", ["-c", "sleep 5"], { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const r = await within(3000, p);
  expect(r.code).not.toBe(0);
});

test("MAX_BUFFER is 64MB", () => {
  expect(MAX_BUFFER).toBe(64 * 1024 * 1024);
});

// --- Deadlines -------------------------------------------------------------
// Nothing in the suite bounded a subprocess before this. A verify command, a
// linter, or a subagent could run forever. The contract stays "always resolves":
// a deadline is reported through the result, never by rejecting.

test("a command exceeding its timeout resolves, non-zero, with killed set", async () => {
  const r = await within(3000, defaultExec("sh", ["-c", "sleep 5"], { timeout: 100 }));
  expect(r.code).not.toBe(0);
  expect(r.killed).toBe(true);
});

// The case that makes `killed` a field rather than a string annotation. execFile
// hands back whatever the child wrote before it was killed, so a deadline is
// otherwise indistinguishable from an ordinary failure — the same class of lie as
// reporting a wedged language server as "(none found)".
test("a command that writes to stderr and THEN times out still reports killed", async () => {
  const r = await within(3000, defaultExec("sh", ["-c", "printf partial >&2; sleep 5"], { timeout: 150 }));
  expect(r.stderr).toContain("partial");
  expect(r.killed).toBe(true);
  expect(r.code).not.toBe(0);
});

test("an ordinary non-zero exit is not reported as killed", async () => {
  const r = await defaultExec("sh", ["-c", "printf boom >&2; exit 3"]);
  expect(r.code).toBe(3);
  expect(r.killed).toBe(false);
});

test("a successful command is not reported as killed", async () => {
  expect((await defaultExec("sh", ["-c", "printf ok"])).killed).toBe(false);
});

test("omitting timeout still completes a fast command under the backstop", async () => {
  const r = await within(3000, defaultExec("sh", ["-c", "printf fast"]));
  expect(r.stdout).toBe("fast");
  expect(r.killed).toBe(false);
});

// --- Env unset -------------------------------------------------------------
// pi-git must strip GIT_DIR / GIT_INDEX_FILE and friends so an inherited
// environment cannot redirect it at another repository. Merging cannot express
// that, so an explicit `undefined` removes the variable.

test("an undefined env value removes the variable from the child", async () => {
  process.env.PI_SUITE_UNSET_ME = "inherited";
  try {
    const r = await defaultExec("sh", ["-c", "printf '[%s]' \"$PI_SUITE_UNSET_ME\""], {
      env: { PI_SUITE_UNSET_ME: undefined },
    });
    expect(r.stdout).toBe("[]");
  } finally {
    delete process.env.PI_SUITE_UNSET_ME;
  }
});

test("removing one variable leaves the rest of the environment intact", async () => {
  process.env.PI_SUITE_UNSET_ME = "inherited";
  try {
    const r = await defaultExec("sh", ["-c", "printf '%s' \"$HOME\""], {
      env: { PI_SUITE_UNSET_ME: undefined },
    });
    expect(r.stdout).toBe(process.env.HOME ?? "");
  } finally {
    delete process.env.PI_SUITE_UNSET_ME;
  }
});

test("a defined env value still sets the variable", async () => {
  const r = await defaultExec("sh", ["-c", "printf '%s' \"$PI_SUITE_SET_ME\""], {
    env: { PI_SUITE_SET_ME: "value" },
  });
  expect(r.stdout).toBe("value");
});
