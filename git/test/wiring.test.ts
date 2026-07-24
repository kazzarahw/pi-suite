import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, fakeCtx } from "../../shared/test/harness.ts";
import { saveConfig, DEFAULTS, type GitConfig } from "../src/config.ts";

function withConfig<T>(cfg: Partial<GitConfig>, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-git-wiring-"));
  saveConfig({ ...DEFAULTS, ...cfg });
  return fn().finally(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  });
}

const userEntry = { type: "message", id: "entry-1", message: { role: "user" } };

// HOUSE-STYLE §3: automatic behavior is a hook, not a tool. pi-git is the purest
// case — it exposes NO agent tools at all. Pinned so a future change has to be deliberate.
test("git registers ZERO agent tools and exactly one command", async () => {
  const api = await loadExtension("git");
  expect([...api.tools.keys()]).toEqual([]);
  expect([...api.commands.keys()]).toEqual(["pi-git"]);
});

test("git subscribes message_start, session_before_fork, session_shutdown", async () => {
  const api = await loadExtension("git");
  for (const hook of ["message_start", "session_before_fork", "session_shutdown"]) {
    expect(api.subscribes(hook)).toBe(true);
  }
});

// The checkpoint is anchored to the FIRST ASSISTANT message of a turn, because the
// user entry is not the session leaf any earlier. A user-role message_start must
// therefore be ignored.
test("git does not checkpoint on a user-role message_start", async () => {
  const api = await loadExtension("git");
  const dir = mkdtempSync(join(tmpdir(), "pi-git-user-"));
  await api.fire(
    "message_start",
    { message: { role: "user" } },
    fakeCtx({ cwd: dir, leafEntry: userEntry }),
  );
  expect(api.emitted.filter((e) => e.event === "git:checkpoint")).toEqual([]);
});

test("git does not checkpoint outside a git repo", async () => {
  const api = await loadExtension("git");
  const dir = mkdtempSync(join(tmpdir(), "pi-git-norepo-"));
  await api.fire(
    "message_start",
    { message: { role: "assistant" } },
    fakeCtx({ cwd: dir, leafEntry: userEntry }),
  );
  expect(api.emitted.filter((e) => e.event === "git:checkpoint")).toEqual([]);
});

test("mode:off suppresses checkpointing", async () => {
  await withConfig({ mode: "off" }, async () => {
    const api = await loadExtension("git");
    const dir = mkdtempSync(join(tmpdir(), "pi-git-off-"));
    await api.fire(
      "message_start",
      { message: { role: "assistant" } },
      fakeCtx({ cwd: dir, leafEntry: userEntry }),
    );
    expect(api.emitted).toEqual([]);
  });
});

// Restore must fire only for a committing fork, never for a normal quit — otherwise
// exiting pi would revert the user's working tree.
test("git does not restore on a non-fork shutdown", async () => {
  const api = await loadExtension("git");
  const dir = mkdtempSync(join(tmpdir(), "pi-git-quit-"));
  await api.fire("session_before_fork", { entryId: "entry-1", position: "before" }, fakeCtx({ cwd: dir }));
  await api.fire("session_shutdown", { reason: "quit" }, fakeCtx({ cwd: dir }));
  expect(api.emitted.filter((e) => e.event === "git:rollback")).toEqual([]);
});
