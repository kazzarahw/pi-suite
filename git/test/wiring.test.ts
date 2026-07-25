import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, fakeCtx, type FakeApi, type FakeCtxOverrides } from "../../shared/test/harness.ts";
import { saveConfig, DEFAULTS, type GitConfig } from "../src/config.ts";

/**
 * pi-git's wiring: four hooks turning Pi's session tree into file undo/redo.
 *
 * Every test runs against a temp agent directory, so the checkpoint store never
 * touches the real `~/.pi/agent`, and against a temp project.
 */
function withConfig<T>(cfg: Partial<GitConfig>, fn: (agentDir: string) => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-git-wiring-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  saveConfig({ ...DEFAULTS, ...cfg });
  return fn(agentDir).finally(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(agentDir, { recursive: true, force: true });
  });
}

const project = (): string => realpathSync(mkdtempSync(join(tmpdir(), "pi-git-proj-")));

const gitCmd = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

const write = (base: string, rel: string, content: string): string => {
  const abs = join(base, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
};

const read = (abs: string): string => readFileSync(abs, "utf8");

const userEntry = (id: string) => ({ type: "message", id, message: { role: "user" } });

/** Drive one full turn: the agent edits `path`, and the turn's checkpoint is taken. */
async function turn(
  api: FakeApi,
  entryId: string,
  cwd: string,
  edits: Array<{ path: string; content: string }>,
  overrides: FakeCtxOverrides = {},
): Promise<void> {
  const ctx = fakeCtx({ cwd, leafEntry: userEntry(entryId), ...overrides });
  await api.fire("message_start", { message: { role: "assistant" } }, ctx);
  for (const edit of edits) {
    await api.fire("tool_call", { toolName: "write", input: { path: edit.path } }, ctx);
    writeFileSync(edit.path, edit.content, "utf8");
  }
}

// --- Surface ---------------------------------------------------------------

// HOUSE-STYLE §3: automatic behavior is a hook, not a tool. pi-git is the purest
// case — it exposes NO agent tools at all. Pinned so a future change has to be deliberate.
test("git registers ZERO agent tools and exactly one command", async () => {
  const api = await loadExtension("git");
  expect([...api.tools.keys()]).toEqual([]);
  expect([...api.commands.keys()]).toEqual(["pi-git"]);
});

// D11: slash commands are the configuration surface, not an action surface. Rewinding
// is something the harness does on navigation, not a verb the user (or model) invokes.
test("/pi-git takes only a mode argument — no checkpoint or restore verbs", async () => {
  const api = await loadExtension("git");
  const completions = api.commands.get("pi-git")!.getArgumentCompletions?.("") as
    | Array<{ value: string }>
    | null;
  expect((completions ?? []).map((c) => c.value).sort()).toEqual(["block", "notify", "off"]);
});

test("git subscribes the four checkpoint hooks and the fork pair", async () => {
  const api = await loadExtension("git");
  for (const hook of [
    "tool_call",
    "message_start",
    "session_before_tree",
    "session_tree",
    "session_before_fork",
    "session_shutdown",
  ]) {
    expect(api.subscribes(hook)).toBe(true);
  }
});

test("the tool_call hook never blocks a tool", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const ctx = fakeCtx({ cwd, leafEntry: userEntry("u1") });
      const result = await api.fire("tool_call", { toolName: "write", input: { path: join(cwd, "a.txt") } }, ctx);
      expect(result).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- Guards ----------------------------------------------------------------

test("git does not checkpoint on a user-role message_start", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      await api.fire("message_start", { message: { role: "user" } }, fakeCtx({ cwd, leafEntry: userEntry("u1") }));
      expect(api.emitted.filter((e) => e.event === "git:checkpoint")).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("mode:off suppresses everything", async () => {
  await withConfig({ mode: "off" }, async (agentDir) => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const ctx = fakeCtx({ cwd, leafEntry: userEntry("u1") });
      await api.fire("tool_call", { toolName: "write", input: { path: join(cwd, "a.txt") } }, ctx);
      await api.fire("message_start", { message: { role: "assistant" } }, ctx);
      await api.fire("session_before_tree", {}, ctx);
      await api.fire("session_tree", { newLeafId: "u1", oldLeafId: "u1" }, ctx);
      expect(api.emitted).toEqual([]);
      expect(existsSync(join(agentDir, "checkpoints"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// Restore must fire only for a committing fork, never for a normal quit — otherwise
// exiting pi would revert the user's working tree.
test("git does not restore on a non-fork shutdown", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const ctx = fakeCtx({ cwd });
      await api.fire("session_before_fork", { entryId: "u1", position: "before" }, ctx);
      await api.fire("session_shutdown", { reason: "quit" }, ctx);
      expect(api.emitted.filter((e) => e.event === "git:rollback")).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- Undo and redo ---------------------------------------------------------

test("navigating back to an earlier entry restores the files it was sent with", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }]);
      await turn(api, "u2", cwd, [{ path: f, content: "v2" }]);
      expect(read(f)).toBe("v2");

      // /tree: leave the current leaf, land on u1.
      const at2 = fakeCtx({ cwd, leafEntry: userEntry("u2"), leafId: "a2" });
      await api.fire("session_before_tree", {}, at2);
      const at1 = fakeCtx({ cwd, leafEntry: userEntry("u1"), leafId: "u1" });
      await api.fire("session_tree", { newLeafId: "u1", oldLeafId: "a2" }, at1);

      expect(read(f)).toBe("v0");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// The half of rewind that the old ref-based design never had. It works because
// session_before_tree keys its checkpoint to the *leaf*, leaving the user message's
// own record — the state it was sent in — intact.
test("navigating forward again restores the later state", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }]);
      await turn(api, "u2", cwd, [{ path: f, content: "v2" }]);

      const tree = { a2: { id: "a2", parentId: "u2" }, u2: { id: "u2", parentId: "u1" }, u1: { id: "u1", parentId: null } };
      await api.fire("session_before_tree", {}, fakeCtx({ cwd, leafId: "a2", entries: tree }));
      await api.fire(
        "session_tree",
        { newLeafId: "u1", oldLeafId: "a2" },
        fakeCtx({ cwd, leafId: "u1", leafEntry: userEntry("u1"), entries: tree }),
      );
      expect(read(f)).toBe("v0");

      // ...and forward again.
      await api.fire("session_before_tree", {}, fakeCtx({ cwd, leafId: "u1", entries: tree }));
      await api.fire(
        "session_tree",
        { newLeafId: "a2", oldLeafId: "u1" },
        fakeCtx({ cwd, leafId: "a2", entries: tree }),
      );
      expect(read(f)).toBe("v2");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("navigating to an entry that was never a checkpoint anchor walks up to one", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }]);
      await turn(api, "u2", cwd, [{ path: f, content: "v2" }]);

      // a1 is an assistant entry inside turn 1 — never checkpointed itself.
      const tree = { a1: { id: "a1", parentId: "u1" }, u1: { id: "u1", parentId: null } };
      await api.fire("session_before_tree", {}, fakeCtx({ cwd, leafId: "a2", entries: tree }));
      await api.fire("session_tree", { newLeafId: "a1", oldLeafId: "a2" }, fakeCtx({ cwd, leafId: "a1", entries: tree }));

      expect(read(f)).toBe("v0");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a file the agent created is deleted when navigating to before it existed", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const anchor = write(cwd, "anchor.txt", "anchor");
      await turn(api, "u1", cwd, []);
      const made = join(cwd, "made.txt");
      await turn(api, "u2", cwd, [{ path: made, content: "brand new" }]);
      expect(existsSync(made)).toBe(true);

      await api.fire("session_before_tree", {}, fakeCtx({ cwd, leafId: "a2" }));
      await api.fire(
        "session_tree",
        { newLeafId: "u1", oldLeafId: "a2" },
        fakeCtx({ cwd, leafId: "u1", leafEntry: userEntry("u1") }),
      );

      expect(existsSync(made)).toBe(false);
      expect(read(anchor)).toBe("anchor");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("navigating somewhere with no checkpoint says so instead of silently doing nothing", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const ctx = fakeCtx({ cwd, leafId: "unknown-leaf" });
      await api.fire("session_tree", { newLeafId: "unknown-leaf", oldLeafId: null }, ctx);
      expect(ctx.uiCalls.notices.map((n) => n.msg).join(" ")).toContain("no file checkpoint");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- The cases the storage rewrite exists for ------------------------------

test("a session rooted above a nested repository restores both sides", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      // ~/dev/pi containing ~/dev/pi/pi-suite: the layout that produced a silent
      // half-restore under the old `git add -A` snapshot.
      gitCmd(cwd, "init", "-q");
      const inner = join(cwd, "inner");
      mkdirSync(inner, { recursive: true });
      gitCmd(inner, "init", "-q");

      const outer = write(cwd, "test.txt", "outer v0");
      const innerFile = write(inner, "test.txt", "inner v0");

      await turn(api, "u1", cwd, []);
      await turn(api, "u2", cwd, [
        { path: outer, content: "outer v1" },
        { path: innerFile, content: "inner v1" },
      ]);

      await api.fire("session_before_tree", {}, fakeCtx({ cwd, leafId: "a2" }));
      await api.fire(
        "session_tree",
        { newLeafId: "u1", oldLeafId: "a2" },
        fakeCtx({ cwd, leafId: "u1", leafEntry: userEntry("u1") }),
      );

      expect(read(outer)).toBe("outer v0");
      expect(read(innerFile)).toBe("inner v0"); // the half-restore this replaces
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a file bash created is picked up by change detection inside a repository", async () => {
  await withConfig({ detectDirty: true }, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      gitCmd(cwd, "init", "-q");
      gitCmd(cwd, "config", "user.email", "t@example.com");
      gitCmd(cwd, "config", "user.name", "T");
      write(cwd, "seed.txt", "seed");
      gitCmd(cwd, "add", "-A");
      gitCmd(cwd, "commit", "-qm", "base");

      // Turn 1 leaves a file behind that never passed through write/edit.
      const byBash = write(cwd, "from-bash.txt", "v1");
      await turn(api, "u1", cwd, []); // checkpoint sees it via git status
      writeFileSync(byBash, "v2", "utf8");
      await turn(api, "u2", cwd, []);

      await api.fire("session_before_tree", {}, fakeCtx({ cwd, leafId: "a2" }));
      await api.fire(
        "session_tree",
        { newLeafId: "u1", oldLeafId: "a2" },
        fakeCtx({ cwd, leafId: "u1", leafEntry: userEntry("u1") }),
      );

      expect(read(byBash)).toBe("v1");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a non-git directory still checkpoints, and gains no .git", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }]);
      await turn(api, "u2", cwd, [{ path: f, content: "v2" }]);

      await api.fire("session_before_tree", {}, fakeCtx({ cwd, leafId: "a2" }));
      await api.fire(
        "session_tree",
        { newLeafId: "u1", oldLeafId: "a2" },
        fakeCtx({ cwd, leafId: "u1", leafEntry: userEntry("u1") }),
      );

      expect(read(f)).toBe("v0");
      expect(readdirSync(cwd)).toEqual(["a.txt"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("checkpoints live under the agent directory, never in the project", async () => {
  await withConfig({}, async (agentDir) => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }]);
      expect(existsSync(join(agentDir, "checkpoints", "test-session"))).toBe(true);
      expect(readdirSync(cwd)).toEqual(["a.txt"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- Fork ------------------------------------------------------------------

test("a committing fork restores the forked-to entry", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }]);
      await turn(api, "u2", cwd, [{ path: f, content: "v2" }]);

      const ctx = fakeCtx({ cwd });
      await api.fire("session_before_fork", { entryId: "u1", position: "before" }, ctx);
      await api.fire("session_shutdown", { reason: "fork" }, ctx);

      expect(read(f)).toBe("v0");
      expect(api.emitted.some((e) => e.event === "git:rollback")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
