import { test, expect } from "bun:test";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManager } from "../src/lsp/manager.ts";
import type { ServerSpec } from "../src/lsp/config.ts";
import { within } from "../../shared/test/harness.ts";

let seq = 0;
function tmpJson(): string {
  const f = join(tmpdir(), `pi-lens-mgr-${process.pid}-${seq++}.json`);
  writeFileSync(f, '{"a":1}\n');
  return f;
}

const MISSING: Record<string, ServerSpec> = {
  json: { command: ["vscode-json-language-server", "--stdio"], languageId: "json" },
};

// The reported bug: reading a .json file hangs when the server binary isn't installed,
// because `initialize` never gets a response and the await was unbounded. A missing binary
// must be treated as "no server" — fast, empty, no spawn.
test("pull() returns [] promptly when the server binary is not installed (no hang)", async () => {
  const f = tmpJson();
  const mgr = createManager(MISSING, () => false);
  try {
    expect(await within(2000, mgr.pull(f, process.cwd()))).toEqual([]);
    expect(await within(2000, mgr.ready(f, process.cwd()))).toBeNull();
  } finally {
    await mgr.shutdownAll();
    rmSync(f, { force: true });
  }
});

// Defense in depth: even a server whose binary *is* present but dies before answering
// `initialize` must not hang the read hook — the process's death unblocks the awaiters.
test("pull() returns [] bounded when a present server dies before responding", async () => {
  const f = tmpJson();
  const dying: Record<string, ServerSpec> = {
    json: { command: ["sh", "-c", "exit 0"], languageId: "json" },
  };
  const mgr = createManager(dying, () => true);
  try {
    expect(await within(3000, mgr.pull(f, process.cwd()))).toEqual([]);
  } finally {
    await mgr.shutdownAll();
    rmSync(f, { force: true });
  }
});

// --- cwd is per-call, not per-manager ---------------------------------------
// pi-lens captured process.cwd() in its extension factory and handed it to
// createManager, so the language server's root — the child's cwd and the
// initialize rootUri — was fixed for the whole session at load time. Where Pi's
// session cwd differed, every diagnostic and query was rooted in the wrong project
// with no way to recover. Keying by (cwd, command) makes a different cwd a
// different server instead of a silently wrong one.

test("a different cwd gets its own server; the same cwd reuses one", async () => {
  const f = tmpJson();
  const spawns: string[] = [];
  const spec: Record<string, ServerSpec> = {
    json: { command: ["sh", "-c", "exit 0"], languageId: "json" },
  };
  const mgr = createManager(spec, (bin) => {
    spawns.push(bin);
    return true;
  });
  try {
    const a1 = mkdtempSync(join(tmpdir(), "lens-cwd-a-"));
    const b1 = mkdtempSync(join(tmpdir(), "lens-cwd-b-"));
    await within(3000, mgr.pull(f, a1));
    const afterFirst = spawns.length;
    await within(3000, mgr.pull(f, a1));
    await within(3000, mgr.pull(f, b1));
    // Same cwd must not re-resolve a new server; a new cwd must.
    expect(spawns.length).toBeGreaterThan(afterFirst);
    rmSync(a1, { recursive: true, force: true });
    rmSync(b1, { recursive: true, force: true });
  } finally {
    await mgr.shutdownAll();
    rmSync(f, { force: true });
  }
});

test("shutdownAll tears down servers across every cwd", async () => {
  const f = tmpJson();
  const spec: Record<string, ServerSpec> = {
    json: { command: ["sh", "-c", "exit 0"], languageId: "json" },
  };
  const mgr = createManager(spec, () => true);
  const a = mkdtempSync(join(tmpdir(), "lens-cwd-c-"));
  const b = mkdtempSync(join(tmpdir(), "lens-cwd-d-"));
  await within(3000, mgr.pull(f, a));
  await within(3000, mgr.pull(f, b));
  // Must resolve, not hang, with more than one cwd registered.
  await within(3000, mgr.shutdownAll());
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
  rmSync(f, { force: true });
});

// pull() must absorb a bounded-wait rejection: absent diagnostics are genuinely
// absent, and the read/edit hook must never break because a server misbehaved.
// A server that is alive but silent is the slowest bounded path, and the one the old
// code hung on forever: `warm` never fired and `initialize` never settled. It must now
// finish inside ONE WARM_TIMEOUT_MS budget (6s) — not the request deadline plus the warm
// timeout, which would be ~16s on a hook that runs after every read and edit. Given more
// than bun's 5s default because 6s of real waiting is the behaviour under test.
test(
  "pull() resolves [] rather than throwing when the server never answers",
  async () => {
    const f = tmpJson();
    const silent: Record<string, ServerSpec> = {
      json: { command: ["sh", "-c", "sleep 30"], languageId: "json" },
    };
    const mgr = createManager(silent, () => true);
    try {
      expect(await within(9_000, mgr.pull(f, process.cwd(), 100))).toEqual([]);
    } finally {
      await mgr.shutdownAll();
      rmSync(f, { force: true });
    }
  },
  15_000,
);
