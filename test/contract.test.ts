import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SURFACE, ALL_TOOLS, MANIFEST, entryPoint, EVENTS } from "../shared/index.ts";
import { loadExtension } from "../shared/test/harness.ts";

/**
 * The drift guards.
 *
 * The suite's surface used to be described in prose, and that description drifted from
 * the code repeatedly: a tool count that was wrong, a pi-git worktree capability that
 * was dead code, event subscriptions that did not exist. Each was found by hand, weeks
 * later. These tests make that class of drift a CI failure instead.
 *
 * **Every assertion here must hold for any subset of SURFACE.** Extensions are peers:
 * disabling one to prototype a replacement must not turn the suite red. That rules out
 * anything keyed to a particular count — an earlier version asserted "exactly seven
 * agent tools", which meant commenting one entry out of package.json failed a test
 * about a completely unrelated extension. Properties, not totals.
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

/**
 * No two extensions claim the same tool name.
 *
 * This is the property that actually matters when one is swapped out: a replacement
 * registering a name its predecessor still holds would have one silently shadow the
 * other, depending on load order. Unlike a total, it stays true for any subset.
 */
test("no two extensions register the same tool name", async () => {
  const owners = new Map<string, string>();
  const clashes: string[] = [];
  for (const ext of SURFACE) {
    const api = await loadExtension(ext.dir);
    for (const tool of api.tools.keys()) {
      const existing = owners.get(tool);
      if (existing) clashes.push(`"${tool}" registered by both ${existing} and ${ext.dir}`);
      else owners.set(tool, ext.dir);
    }
  }
  expect(clashes).toEqual([]);
});

test("the live registry, taken together, is exactly what SURFACE declares", async () => {
  const registered: string[] = [];
  for (const ext of SURFACE) {
    const api = await loadExtension(ext.dir);
    registered.push(...api.tools.keys());
  }
  // Derived from SURFACE on both sides — true for whatever set SURFACE currently holds,
  // rather than pinned to a count that a deliberate removal would break.
  expect(registered.sort()).toEqual([...ALL_TOOLS].sort());
});

// ---------------------------------------------------------------------------
// Every tool follows the house naming and description rules (see shared/README.md).
// ---------------------------------------------------------------------------

/**
 * One tool per extension, named after the extension.
 *
 * The suite used to mix three naming shapes at once — `memory_recall`/`memory_write`,
 * a bare `spawn`, and `browser`/`lens` behind an `action` enum — so there was no rule a
 * user could state, and nothing a test could check beyond "is it snake_case". The rule
 * now is the whole shape: extension `X` registers tool `X` and command `/pi-X`, and a
 * domain with more than one verb dispatches on an `action` parameter rather than minting
 * a second name.
 *
 * Stated as a property of each entry, so it holds for any subset of SURFACE — and so
 * that adding a second tool to an extension has to be a deliberate argument with this
 * test rather than a quiet drift back to three shapes.
 */
for (const ext of SURFACE) {
  test(`[${ext.dir}] registers at most one tool, named after the extension`, async () => {
    const api = await loadExtension(ext.dir);
    const names = [...api.tools.keys()];
    expect(names.length).toBeLessThanOrEqual(1);
    for (const name of names) {
      expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/); // snake_case, still
      expect(name).toBe(ext.dir);
    }
  });
}

/**
 * A domain with several verbs collapses behind `action`, rather than several tools.
 *
 * The counterpart to the rule above: forbidding a second tool name is only coherent if
 * the multi-verb extensions actually expose their verbs somewhere. Checked from the
 * schema so a tool that grows a second verb cannot hide it in prose.
 */
test("every multi-verb tool exposes its verbs as an `action` enum", async () => {
  const MULTI_VERB = ["memory", "browser", "lens"];
  for (const ext of SURFACE) {
    if (!MULTI_VERB.includes(ext.dir)) continue;
    const api = await loadExtension(ext.dir);
    const tool = api.tools.get(ext.dir);
    if (!tool) continue; // disabled — not this test's business
    const action = (tool.parameters as { properties?: Record<string, { enum?: string[] }> })
      .properties?.action;
    expect(action, `${ext.dir} has no \`action\` parameter`).toBeDefined();
    expect(action!.enum?.length ?? 0).toBeGreaterThan(1);
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

/**
 * ...and the vocabulary is *reachable*: nothing is declared that nobody emits.
 *
 * This replaces a `size >= 15` ratchet, which was the wrong guard for what the bus
 * turned out to be. `events.ts` was written spec-first, in the suite's first commit,
 * from a `HOUSE-STYLE.md` §4 that has since been deleted — so a never-shrink rule
 * pinned a wishlist rather than a contract, and would have kept pinning it after the
 * document that justified it was gone.
 *
 * The rule that actually belongs here is the one `test/boundaries.test.ts` already
 * applies to modules: *a capability nothing reaches is not deferred, it is dead.* An
 * event no publisher emits is exactly that — a name a subscriber could bind to and
 * never hear from. The direction matters: this suite deliberately emits several events
 * it does not itself consume, because a publisher with no in-repo subscriber is a
 * working extension point (and every one of them is asserted by that extension's own
 * tests), whereas a declaration with no publisher is a promise nothing keeps.
 */
test("every event declared in EVENTS is emitted by some extension", () => {
  const emitted = new Set<string>();
  for (const ext of SURFACE) {
    for (const file of sourceFiles(ext.dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bemit\(\s*"([a-z]+:[a-z-]+)"/g)) {
        emitted.add(m[1]!);
      }
    }
  }
  // Only for domains actually present: disabling an extension must not fail a claim
  // about it — the same rule the wrapsToolResult check follows.
  const present = new Set(SURFACE.map((e) => e.dir));
  const claimed = [...EVENT_NAMES].filter((name) => {
    const domain = name.split(":")[0]!;
    // `verify:*` is published by pi-lens, so its domain name is not its directory.
    return present.has(domain === "verify" ? "lens" : domain);
  });
  expect(claimed.filter((name) => !emitted.has(name))).toEqual([]);
});

// ---------------------------------------------------------------------------
// Documentation lives with what it documents.
//
// A prose "design contract" describing all seven at once used to sit in docs/ and
// be checked for the presence of every tool name. It drifted from the code three
// times anyway, and it made the suite legible only as a whole — the opposite of the
// property that lets one extension be swapped out. It is gone. The rules that are
// enforceable are enforced here and in test/boundaries.test.ts; the rest lives in
// shared/README.md (how to write an extension) and each <name>/README.md (what that
// extension does).
// ---------------------------------------------------------------------------

test("every extension documents itself, with the standard sections", () => {
  const REQUIRED = ["## What it does", "## Configure", "## Install"];
  const offenders: string[] = [];
  for (const ext of SURFACE) {
    const path = join(ROOT, ext.dir, "README.md");
    let doc: string;
    try {
      doc = readFileSync(path, "utf8");
    } catch {
      offenders.push(`${ext.dir}: no README.md`);
      continue;
    }
    for (const section of REQUIRED) {
      if (!doc.includes(section)) offenders.push(`${ext.dir}/README.md: missing "${section}"`);
    }
    // A tool the agent can call must be named where a human would look for it.
    for (const tool of ext.tools) {
      if (!doc.includes(tool)) offenders.push(`${ext.dir}/README.md: never mentions \`${tool}\``);
    }
  }
  expect(offenders).toEqual([]);
});

// ---------------------------------------------------------------------------
// The manifest is derived, not maintained twice.
// ---------------------------------------------------------------------------

const manifest = (): string[] =>
  (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { pi: { extensions: string[] } })
    .pi.extensions;

/**
 * `package.json` must equal `MANIFEST` — same entries, same order.
 *
 * These were two hand-maintained lists of one fact, reconciled by comparing sorted
 * directory names, which let their *order* drift freely even though order is load
 * order and load order is significant. Deriving one from the other makes adding,
 * removing, or swapping an extension a single edit that cannot silently disagree.
 */
test("package.json pi.extensions matches the manifest derived from SURFACE, in order", () => {
  expect(manifest()).toEqual([...MANIFEST]);
});

/**
 * An extension declaring `wrapsToolResult` must load last.
 *
 * Pi chains `tool_result` handlers as middleware in load order, so the outermost
 * wrapper runs last. pi-lens appends diagnostics to whatever a tool returned; loading it
 * earlier would make its injection the thing a later handler wrapped.
 *
 * Asserted from the declaration rather than by naming lens, and skipped when no present
 * extension claims the property — so removing lens does not fail a claim about lens.
 */
test("any extension that wraps tool_result is last in load order", () => {
  const wrappers = SURFACE.filter((e) => e.wrapsToolResult);
  if (wrappers.length === 0) return;
  expect(wrappers).toHaveLength(1); // two outermost wrappers is a contradiction
  expect(SURFACE.at(-1)?.dir).toBe(wrappers[0]!.dir);
  expect(manifest().at(-1)).toBe(entryPoint(wrappers[0]!.dir));
});

/**
 * The bus is the only cross-extension coupling, and it is optional in both directions.
 *
 * pi-memory subscribes to `verify:failed`, which pi-lens emits. That is the one link in
 * the suite, and it must degrade to nothing rather than fail when the publisher is
 * absent — otherwise pi-lens could not be swapped out. Loading pi-memory alone and
 * firing nothing is exactly that scenario.
 */
test("an extension with a bus subscription loads and works with no publisher present", async () => {
  const api = await loadExtension("memory");
  expect([...api.tools.keys()]).toEqual(["memory"]);
  // Subscribed, but nothing has emitted — no throw, and nothing recorded.
  expect(api.emitted).toEqual([]);
});
