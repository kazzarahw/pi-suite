import { test, expect } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManager } from "../src/lsp/manager.ts";
import type { ServerSpec } from "../src/lsp/config.ts";

/** Reject if a promise doesn't settle within `ms` — turns a hang into a clear test failure. */
const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`did not settle within ${ms}ms`)), ms)),
  ]);

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
  const mgr = createManager(process.cwd(), MISSING, () => false);
  try {
    expect(await within(2000, mgr.pull(f))).toEqual([]);
    expect(await within(2000, mgr.ready(f))).toBeNull();
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
  const mgr = createManager(process.cwd(), dying, () => true);
  try {
    expect(await within(3000, mgr.pull(f))).toEqual([]);
  } finally {
    await mgr.shutdownAll();
    rmSync(f, { force: true });
  }
});
