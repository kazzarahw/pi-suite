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
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/g)) out.push(m[1]!);
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
