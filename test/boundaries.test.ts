import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { SURFACE } from "../shared/index.ts";

/**
 * Import-boundary enforcement (spec D7).
 *
 * Consolidating seven repos into one package removed the structural barrier that
 * kept the extensions independent. This restores it: an extension may import from
 * its own subtree, from `shared/`, from `node:*`, and from the peer packages —
 * nothing else. Cross-extension coupling, if ever wanted, belongs on the event bus,
 * not in an import.
 *
 * Implemented as a test rather than an ESLint rule deliberately: the repo has no
 * ESLint config, and adding one would change pi-lens's own behavior (it gates its
 * ESLint linter on config presence), violating the behavior-preserving constraint.
 */

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const EXTENSION_DIRS = SURFACE.map((e) => e.dir);

const ALLOWED_PACKAGES = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
  "bun:test",
]);

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const entry of readdirSync(p)) {
      const full = join(p, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== "docs") walk(full);
      } else if (entry.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/** Every static import/export specifier in a file. */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  // `[^;]*?` rather than `[\s\S]*?`: an import/export clause never contains a semicolon,
  // so this cannot run past the end of a statement. With the looser pattern, a declaration
  // matched forward into any later prose containing `from "..."` — a comment reading
  // `Distinguishing "slow" from "empty"` was reported as an import of the package "empty".
  // Multi-line clauses still match, since a braced specifier list has no semicolon either.
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*[`"]([^`"]+)[`"]\s*\)/g)) out.push(m[1]!);
  return out;
}

/** Classify a specifier as allowed or not, from the perspective of `file` inside `ext`. */
function violation(ext: string, file: string, spec: string): string | null {
  if (spec.startsWith("node:")) return null;
  if (ALLOWED_PACKAGES.has(spec)) return null;
  if (!spec.startsWith(".")) return `non-peer package "${spec}"`;

  const target = resolve(dirname(file), spec);
  const rel = relative(ROOT, target);
  const top = rel.split("/")[0]!;
  if (top === ext) return null; // own subtree
  if (top === "shared") return null; // the shared module
  if (EXTENSION_DIRS.includes(top)) return `cross-extension import into "${top}" ("${spec}")`;
  return `import escapes the package ("${spec}")`;
}

for (const ext of EXTENSION_DIRS) {
  test(`[${ext}] imports only from its own subtree, shared/, node:*, and peer packages`, () => {
    const offenders: string[] = [];
    for (const file of allTsFiles(ext)) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const problem = violation(ext, file, spec);
        if (problem) offenders.push(`${relative(ROOT, file)}: ${problem}`);
      }
    }
    expect(offenders).toEqual([]);
  });
}

test("shared/ does not import from any extension (it must stay a leaf)", () => {
  const offenders: string[] = [];
  for (const file of allTsFiles("shared")) {
    // shared/test/*.test.ts legitimately imports extension config specs to
    // parameterize over them; production shared/ code must not.
    if (file.includes("/test/")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const top = relative(ROOT, resolve(dirname(file), spec)).split("/")[0]!;
      if (EXTENSION_DIRS.includes(top)) offenders.push(`${relative(ROOT, file)}: imports "${spec}"`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the boundary checker actually detects a cross-extension import", () => {
  // Guards the guard: a checker that can never fail is not a checker.
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "../../git/src/git.ts")).toContain(
    "cross-extension",
  );
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "../../shared/exec.ts")).toBeNull();
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "./config.ts")).toBeNull();
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "node:fs")).toBeNull();
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "lodash")).toContain("non-peer package");
});

// ---------------------------------------------------------------------------
// cwd resolution is centralised (spec D3).
// ---------------------------------------------------------------------------

/**
 * Strip comments, then find `process.cwd()` uses.
 *
 * Comments must go first: several modules now explain *why* they no longer call
 * `process.cwd()`, and a naive scan would flag the explanation as the offence.
 */
function bareCwdUses(src: string): number {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...code.matchAll(/\bprocess\.cwd\(\)/g)].length;
}

/**
 * The correct idiom — `ctx?.sessionManager?.getCwd?.() ?? process.cwd()` — was
 * copy-pasted into four files and missed in five others, and every one of those five
 * was a live defect: pi-lens rooted its language servers and ran the project's verify
 * command in the wrong directory, pi-memory wrote captured memories beside whatever
 * directory Pi was launched from. Deduplicating into `cwdOf` fixes today's misses;
 * this test is what stops the sixth copy from being written.
 */
test("process.cwd() appears nowhere outside shared/cwd.ts", () => {
  const offenders: string[] = [];
  for (const dir of [...EXTENSION_DIRS, "shared"]) {
    for (const file of allTsFiles(dir)) {
      const rel = relative(ROOT, file);
      if (rel === "shared/cwd.ts") continue; // the one permitted implementation
      if (rel.includes("/test/")) continue; // tests legitimately compare against it
      const n = bareCwdUses(readFileSync(file, "utf8"));
      if (n > 0) offenders.push(`${rel}: ${n} use(s) — call cwdOf(ctx) instead`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the cwd checker actually detects a bare use, and ignores prose about one", () => {
  // Guards the guard: a checker that can never fail is not a checker.
  expect(bareCwdUses("const d = process.cwd();")).toBe(1);
  expect(bareCwdUses("// we no longer call process.cwd() here\nconst d = cwdOf(ctx);")).toBe(0);
  expect(bareCwdUses("/* history: this used process.cwd() */\nconst d = cwdOf(ctx);")).toBe(0);
  expect(bareCwdUses("const d = cwdOf(ctx);")).toBe(0);
});
