import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SURFACE, ALL_TOOLS, EVENTS } from "../shared/index.ts";
import { loadExtension } from "../shared/test/harness.ts";

/**
 * The drift guards.
 *
 * HOUSE-STYLE.md drifted from the code repeatedly: the appendix listed a tool count
 * that was wrong, described a pi-git worktree capability that was dead code, and
 * documented event subscriptions that did not exist. Each was found by hand, weeks
 * later. These tests make that class of drift a CI failure instead.
 */

const ROOT = new URL("..", import.meta.url).pathname;
const EVENT_NAMES: Set<string> = new Set(
  Object.values(EVENTS).flatMap((group) => Object.values(group) as string[]),
);

/** Every `.ts` file under an extension directory (excluding its tests). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const entry of readdirSync(p)) {
      const full = join(p, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "test" && entry !== "node_modules" && entry !== "docs") walk(full);
      } else if (entry.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(join(ROOT, dir));
  return out;
}

// ---------------------------------------------------------------------------
// The agent surface matches SURFACE exactly.
// ---------------------------------------------------------------------------

for (const ext of SURFACE) {
  test(`[${ext.dir}] registers exactly the tools declared in SURFACE`, async () => {
    const api = await loadExtension(ext.dir);
    expect([...api.tools.keys()].sort()).toEqual([...ext.tools].sort());
  });

  test(`[${ext.dir}] registers exactly one command, named ${ext.command}`, async () => {
    const api = await loadExtension(ext.dir);
    expect([...api.commands.keys()]).toEqual([ext.command]);
  });
}

test("the suite exposes exactly seven agent tools, with no duplicates", async () => {
  const registered: string[] = [];
  for (const ext of SURFACE) {
    const api = await loadExtension(ext.dir);
    registered.push(...api.tools.keys());
  }
  expect(registered.sort()).toEqual([...ALL_TOOLS].sort());
  expect(new Set(registered).size).toBe(registered.length);
  expect(registered.length).toBe(7);
});

// ---------------------------------------------------------------------------
// Every tool follows the house naming and description rules (HOUSE-STYLE §3).
// ---------------------------------------------------------------------------

test("every tool name is snake_case <domain>_<verb> or a bare verb", async () => {
  for (const ext of SURFACE) {
    const api = await loadExtension(ext.dir);
    for (const name of api.tools.keys()) {
      expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  }
});

test("every tool has a description and a promptSnippet", async () => {
  for (const ext of SURFACE) {
    const api = await loadExtension(ext.dir);
    for (const [name, tool] of api.tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.promptSnippet, `${name} is missing a promptSnippet`).toBeTruthy();
    }
  }
});

// ---------------------------------------------------------------------------
// The event vocabulary is closed: nothing is emitted that EVENTS does not declare.
// ---------------------------------------------------------------------------

test("every emitted event name is declared in EVENTS", () => {
  const offenders: string[] = [];
  for (const ext of SURFACE) {
    for (const file of sourceFiles(ext.dir)) {
      const src = readFileSync(file, "utf8");
      // Matches emit("domain:event", …) and pi.events.emit("domain:event", …).
      for (const m of src.matchAll(/\bemit\(\s*"([a-z]+:[a-z-]+)"/g)) {
        const name = m[1]!;
        if (!EVENT_NAMES.has(name)) offenders.push(`${file.replace(ROOT, "")}: "${name}"`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("EVENTS declares one event per emitting domain, and the vocabulary does not shrink", () => {
  // 13 today: consult 1, lens 2, verify 2, git 2, todo 2, memory 2, spawn 2.
  expect(EVENT_NAMES.size).toBeGreaterThanOrEqual(13);
  for (const domain of ["consult", "lens", "verify", "git", "todo", "memory", "spawn"]) {
    expect([...EVENT_NAMES].some((e) => e.startsWith(`${domain}:`))).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// The docs are checked AGAINST the code, never the reverse.
// ---------------------------------------------------------------------------

test("HOUSE-STYLE mentions every tool the suite actually registers", () => {
  const doc = readFileSync(join(ROOT, "shared", "HOUSE-STYLE.md"), "utf8");
  const missing = ALL_TOOLS.filter((t) => !doc.includes(t));
  expect(missing).toEqual([]);
});

test("HOUSE-STYLE mentions every /pi-<name> command", () => {
  const doc = readFileSync(join(ROOT, "shared", "HOUSE-STYLE.md"), "utf8");
  const missing = SURFACE.map((e) => `/${e.command}`).filter((c) => !doc.includes(c));
  expect(missing).toEqual([]);
});

test("SURFACE covers every extension directory declared in package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  };
  const declared = pkg.pi.extensions.map((p) => p.split("/")[1]!).sort();
  expect(SURFACE.map((e) => e.dir).sort()).toEqual(declared);
});

test("package.json load order puts lens last (its tool_result wraps outermost)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  };
  expect(pkg.pi.extensions.at(-1)).toBe("./lens/index.ts");
});
