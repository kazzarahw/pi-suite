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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, fakeCtx, type FakeApi, type FakeCtxOverrides } from "../../shared/test/harness.ts";
import { saveConfig, DEFAULTS, type GitConfig } from "../src/config.ts";
import { CHECKPOINT_LABEL } from "../index.ts";

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

/**
 * pi-git defers its rewind notifications past Pi's own repaint — see
 * `announceAfterRepaint`, and the reason it has to. Tests reading `uiCalls.notices` must
 * let the macrotask queue drain first.
 */
const settleNotices = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

// House rule: automatic behavior is a hook, not a tool. pi-git is the purest
// case — it exposes NO agent tools at all. Pinned so a future change has to be deliberate.
test("git registers ZERO agent tools and exactly one command", async () => {
  const api = await loadExtension("git");
  expect([...api.tools.keys()]).toEqual([]);
  expect([...api.commands.keys()]).toEqual(["pi-git"]);
});

// D11: slash commands are the configuration surface, not an action surface. Rewinding
// is something the harness does on navigation, not a verb the user (or model) invokes.
//
// Asserted as "no action verbs" rather than "exactly the three modes", which is what this
// used to check. That older form pinned a limitation instead of the rule: pi-git grew
// `detect` and `ttl` verbs when the seven commands were unified, so every field became
// settable from an argument rather than only from the TUI panel. That is a strictly wider
// *configuration* surface and leaves the actual invariant untouched.
test("/pi-git exposes configuration verbs only — no checkpoint, restore, or rollback", async () => {
  const api = await loadExtension("git");
  const completions = api.commands.get("pi-git")!.getArgumentCompletions?.("") as
    | Array<{ value: string }>
    | null;
  const words = (completions ?? []).map((c) => c.value);

  for (const action of ["checkpoint", "restore", "rollback", "rewind", "undo", "snapshot"]) {
    expect(words).not.toContain(action);
  }
  // Every offered word is a config field's verb or one of its values — nothing else.
  const allowed = new Set([
    "mode",
    "detect",
    "guard",
    "guardshell",
    "ttl",
    "maxbytes",
    "off",
    "notify",
    "block",
  ]);
  expect(words.filter((w) => !allowed.has(w))).toEqual([]);
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

// --- The opaque-write guard ------------------------------------------------
//
// `bash` names no path, so `editedPath` has nothing to record and the pre-command bytes
// were never captured. `detectDirty` does not close the gap: it runs at *checkpoint*
// time, by which point the modified content is all there is left to store, and it gets
// stored as the origin. A rewind then restored the file to the state it was being
// rewound *from*, and reported success. Shell edits were the one class of change pi-git
// silently could not undo.

test("a file changed only by bash is restored on rewind", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      gitCmd(cwd, "init");
      gitCmd(cwd, "config", "user.email", "qa@test.local");
      gitCmd(cwd, "config", "user.name", "QA");
      const data = write(cwd, "data.txt", "ORIGINAL\n");
      gitCmd(cwd, "add", "-A");
      gitCmd(cwd, "commit", "-m", "init");

      const ctx = fakeCtx({ cwd, leafEntry: userEntry("u1") });
      await api.fire("message_start", { message: { role: "assistant" } }, ctx);
      // The turn's checkpoint is empty: nothing is dirty and nothing is tracked yet.
      await api.fire("tool_call", { toolName: "bash", input: { command: "printf x > data.txt" } }, ctx);
      writeFileSync(data, "CHANGED BY BASH\n", "utf8");

      // Navigation leaves from the turn's last entry, not from the user message — the
      // two keys are what let backward and forward restore different states.
      await api.fire("session_before_tree", { preparation: { targetId: "u1" } }, fakeCtx({ cwd, leafId: "a1" }));
      await api.fire(
        "session_tree",
        { newLeafId: "u1", oldLeafId: "a1" },
        fakeCtx({ cwd, leafEntry: userEntry("u1"), leafId: "u1" }),
      );

      expect(read(data)).toBe("ORIGINAL\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("the bash guard is skipped when guardOpaqueWrites is off", async () => {
  await withConfig({ guardOpaqueWrites: false }, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      gitCmd(cwd, "init");
      gitCmd(cwd, "config", "user.email", "qa@test.local");
      gitCmd(cwd, "config", "user.name", "QA");
      const data = write(cwd, "data.txt", "ORIGINAL\n");
      gitCmd(cwd, "add", "-A");
      gitCmd(cwd, "commit", "-m", "init");

      const ctx = fakeCtx({ cwd, leafEntry: userEntry("u1") });
      await api.fire("message_start", { message: { role: "assistant" } }, ctx);
      await api.fire("tool_call", { toolName: "bash", input: { command: "printf x > data.txt" } }, ctx);
      writeFileSync(data, "CHANGED BY BASH\n", "utf8");

      await api.fire("session_before_tree", { preparation: { targetId: "u1" } }, fakeCtx({ cwd, leafId: "a1" }));
      await api.fire(
        "session_tree",
        { newLeafId: "u1", oldLeafId: "a1" },
        fakeCtx({ cwd, leafEntry: userEntry("u1"), leafId: "u1" }),
      );

      // The documented cost of turning it off, pinned so it stays a choice.
      expect(read(data)).toBe("CHANGED BY BASH\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a bash tool_call never blocks the command", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const ctx = fakeCtx({ cwd, leafEntry: userEntry("u1") });
      const result = await api.fire("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
      expect(result).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- HEAD drift ------------------------------------------------------------

test("a rewind past a commit says so, rather than leaving it to be discovered", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      gitCmd(cwd, "init");
      gitCmd(cwd, "config", "user.email", "qa@test.local");
      gitCmd(cwd, "config", "user.name", "QA");
      write(cwd, "a.txt", "one");
      gitCmd(cwd, "add", "-A");
      gitCmd(cwd, "commit", "-m", "first");

      const ctx = fakeCtx({ cwd, leafEntry: userEntry("u1"), hasUI: true });

      const file = join(cwd, "a.txt");
      await api.fire("message_start", { message: { role: "assistant" } }, ctx);
      await api.fire("tool_call", { toolName: "write", input: { path: file } }, ctx);
      writeFileSync(file, "two", "utf8");

      // The agent commits its own work mid-session — the case that made a working
      // restore read as a broken one.
      gitCmd(cwd, "add", "-A");
      gitCmd(cwd, "commit", "-m", "agent commit");

      await api.fire("session_before_tree", { preparation: { targetId: "u1" } }, fakeCtx({ cwd, leafId: "a1" }));
      const back = fakeCtx({ cwd, leafEntry: userEntry("u1"), leafId: "u1", hasUI: true });
      await api.fire("session_tree", { newLeafId: "u1", oldLeafId: "a1" }, back);

      await settleNotices();
      const notices = back.uiCalls.notices.map((n) => n.msg);
      expect(read(file)).toBe("one");
      expect(notices.some((n) => n.includes("file(s) restored"))).toBe(true);
      expect(notices.some((n) => n.includes("HEAD moved during this session"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a rewind with no commit in between says nothing about HEAD", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      gitCmd(cwd, "init");
      gitCmd(cwd, "config", "user.email", "qa@test.local");
      gitCmd(cwd, "config", "user.name", "QA");
      write(cwd, "a.txt", "one");
      gitCmd(cwd, "add", "-A");
      gitCmd(cwd, "commit", "-m", "first");

      const ctx = fakeCtx({ cwd, leafEntry: userEntry("u1"), hasUI: true });

      const file = join(cwd, "a.txt");
      await api.fire("message_start", { message: { role: "assistant" } }, ctx);
      await api.fire("tool_call", { toolName: "write", input: { path: file } }, ctx);
      writeFileSync(file, "two", "utf8");

      await api.fire("session_before_tree", { preparation: { targetId: "u1" } }, fakeCtx({ cwd, leafId: "a1" }));
      const back = fakeCtx({ cwd, leafEntry: userEntry("u1"), leafId: "u1", hasUI: true });
      await api.fire("session_tree", { newLeafId: "u1", oldLeafId: "a1" }, back);

      await settleNotices();
      const notices = back.uiCalls.notices.map((n) => n.msg);
      expect(read(file)).toBe("one");
      expect(notices.some((n) => n.includes("HEAD moved"))).toBe(false);
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
      await settleNotices();
      expect(ctx.uiCalls.notices.map((n) => n.msg).join(" ")).toContain("no file checkpoint");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// The case the live dogfood exposed. Selecting a user message in /tree moves the leaf
// to that message's *parent* and puts its text back in the composer, so `newLeafId` is
// one entry earlier than what was chosen — and `null` for the first message of a
// session. Restoring from `newLeafId` did nothing at exactly the point a user most
// wants an undo: all the way back. `preparation.targetId` is the entry actually chosen.
test("navigating to the first user message undoes the whole session", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const made = join(cwd, "made.txt");
      await turn(api, "u1", cwd, [{ path: made, content: "created in turn 1" }]);
      await turn(api, "u2", cwd, [{ path: made, content: "changed in turn 2" }]);
      expect(existsSync(made)).toBe(true);

      // Pi reports newLeafId: null — there is no entry before the first message.
      await api.fire("session_before_tree", { preparation: { targetId: "u1", oldLeafId: "a2" } }, fakeCtx({ cwd, leafId: "a2" }));
      await api.fire("session_tree", { newLeafId: null, oldLeafId: "a2" }, fakeCtx({ cwd, leafId: null }));

      expect(existsSync(made)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("the chosen entry wins over the resulting leaf", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }]);
      await turn(api, "u2", cwd, [{ path: f, content: "v2" }]);

      // newLeafId points at u1 (the parent of the chosen u2); the target is u2, whose
      // checkpoint holds "v1" — the state u2 was sent in.
      await api.fire("session_before_tree", { preparation: { targetId: "u2", oldLeafId: "a2" } }, fakeCtx({ cwd, leafId: "a2" }));
      await api.fire("session_tree", { newLeafId: "u1", oldLeafId: "a2" }, fakeCtx({ cwd, leafId: "u1" }));

      expect(read(f)).toBe("v1");
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

// --- Garbage collection ----------------------------------------------------
//
// The only step here a revert cannot undo, because it deletes data. Age-based rather
// than a count cap: navigation can reach arbitrarily far back, so pruning all but the
// newest N would silently break a restore that is still reachable.

const DAY = 86_400_000;

function age(dir: string, days: number): void {
  const past = new Date(Date.now() - days * DAY);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), past, past);
  utimesSync(dir, past, past);
}

test("session_start prunes checkpoints past the TTL and keeps recent ones", async () => {
  await withConfig({ checkpointTtlDays: 30 }, async (agentDir) => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }], { sessionId: "stale-session" });
      await turn(api, "u2", cwd, [{ path: f, content: "v2" }], { sessionId: "recent-session" });

      const checkpoints = join(agentDir, "checkpoints");
      age(join(checkpoints, "stale-session"), 60);

      await api.fire("session_start", {}, fakeCtx({ cwd, sessionId: "brand-new" }));

      expect(existsSync(join(checkpoints, "stale-session"))).toBe(false);
      expect(existsSync(join(checkpoints, "recent-session"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("session_start never prunes the session that is starting", async () => {
  await withConfig({ checkpointTtlDays: 30 }, async (agentDir) => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      const f = write(cwd, "a.txt", "v0");
      await turn(api, "u1", cwd, [{ path: f, content: "v1" }], { sessionId: "resumed" });
      const checkpoints = join(agentDir, "checkpoints");
      age(join(checkpoints, "resumed"), 900);

      // Resuming a long-dormant session must not throw away the history you resumed for.
      await api.fire("session_start", {}, fakeCtx({ cwd, sessionId: "resumed" }));

      expect(existsSync(join(checkpoints, "resumed"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("mode:off skips the sweep entirely", async () => {
  await withConfig({ mode: "off" }, async (agentDir) => {
    const api = await loadExtension("git");
    const cwd = project();
    try {
      await api.fire("session_start", {}, fakeCtx({ cwd, sessionId: "s" }));
      expect(existsSync(join(agentDir, "checkpoints"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The delegation guard, end to end.
//
// The one gap a hook could not close: a subagent edits from its own `pi` process, so
// `tool_call` never fires for it here. A file that was clean when the delegation began
// therefore had no origin recorded and survived a rewind untouched — the least
// supervised edits in the suite were the only ones pi-git could not undo.
// ---------------------------------------------------------------------------

test("a rewind past a delegation restores a file the subagent edited", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = mkdtempSync(join(tmpdir(), "pi-git-delegated-"));
    execFileSync("git", ["init", "-q"], { cwd });
    const file = join(cwd, "touched-by-subagent.ts");
    writeFileSync(file, "original\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });

    // A turn happens, and *nothing in it touches this file* — which is exactly the case
    // that used to be lost: it is clean, so it is in no manifest and has no origin.
    await turn(api, "e1", cwd, []);

    // pi-spawn announces a delegation. pi-git records the working set from the payload's
    // cwd, because a bus callback is handed `data` and nothing else.
    api.emitBus("spawn:started", { agent: "worker", cwd });
    // The guard is detached so it never sits on pi-spawn's critical path.
    await new Promise((r) => setTimeout(r, 250));

    // The subagent edits in its own process: no tool_call reaches this extension.
    writeFileSync(file, "rewritten by the subagent\n", "utf8");

    await api.fire(
      "session_tree",
      { newLeafId: "e1" },
      fakeCtx({ cwd, leafEntry: userEntry("e1"), entries: { e1: { id: "e1", parentId: null } } }),
    );
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });
});

test("the delegation guard honors its config flag and mode:off", async () => {
  for (const cfg of [{ guardDelegated: false }, { mode: "off" as const }]) {
    await withConfig(cfg, async () => {
      const api = await loadExtension("git");
      const cwd = mkdtempSync(join(tmpdir(), "pi-git-guard-off-"));
      execFileSync("git", ["init", "-q"], { cwd });
      const file = join(cwd, "f.ts");
      writeFileSync(file, "original\n", "utf8");
      execFileSync("git", ["add", "-A"], { cwd });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd });

      await turn(api, "e1", cwd, []);
      api.emitBus("spawn:started", { agent: "worker", cwd });
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(file, "changed\n", "utf8");

      await api.fire(
        "session_tree",
        { newLeafId: "e1" },
        fakeCtx({ cwd, leafEntry: userEntry("e1"), entries: { e1: { id: "e1", parentId: null } } }),
      );
      expect(readFileSync(file, "utf8")).toBe("changed\n");
    });
  }
});

test("a spawn:started with no cwd guards nothing rather than guessing one", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = mkdtempSync(join(tmpdir(), "pi-git-nocwd-"));
    await turn(api, "e1", cwd, []);
    // Must not throw, and must not fall back to process.cwd() — guarding the wrong
    // repository reports coverage it does not have.
    expect(() => api.emitBus("spawn:started", { agent: "worker" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// /tree labels — the affordance, not just the apology.
// ---------------------------------------------------------------------------

test("a checkpointed entry is labelled so /tree shows what will restore", async () => {
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = mkdtempSync(join(tmpdir(), "pi-git-label-"));
    await turn(api, "e1", cwd, [{ path: join(cwd, "a.ts"), content: "x" }]);
    expect(api.labels.map((l) => l.entryId)).toContain("e1");
    expect(api.labels[0]!.label).toBe(CHECKPOINT_LABEL);
  });
});

test("a label the user set themselves is never overwritten", async () => {
  // Labels are a user feature — bookmarks they wrote. Replacing "before the auth
  // refactor" with a marker would be throwing away the note, not adding to it.
  await withConfig({}, async () => {
    const api = await loadExtension("git");
    const cwd = mkdtempSync(join(tmpdir(), "pi-git-label-keep-"));
    const ctx = fakeCtx({ cwd, leafEntry: userEntry("e1") });
    (ctx.sessionManager as unknown as { getLabel: (id: string) => string }).getLabel = () =>
      "before the auth refactor";
    await api.fire("message_start", { message: { role: "assistant" } }, ctx);
    expect(api.labels).toEqual([]);
  });
});
