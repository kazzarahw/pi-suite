import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { SURFACE } from "../shared/index.ts";

/**
 * Import-boundary enforcement.
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
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "../../git/src/store.ts")).toContain(
    "cross-extension",
  );
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "../../shared/exec.ts")).toBeNull();
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "./config.ts")).toBeNull();
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "node:fs")).toBeNull();
  expect(violation("lens", join(ROOT, "lens/src/tools.ts"), "lodash")).toContain("non-peer package");
});

// ---------------------------------------------------------------------------
// Every module is reachable from its extension's entry point.
// ---------------------------------------------------------------------------

/**
 * Follow relative imports from `entry`, returning every file transitively reached.
 *
 * Resolution is deliberately simple — every internal specifier in this repo is an
 * explicit `./x.ts` path (`allowImportingTsExtensions`), so there are no extensions to
 * infer and no index resolution to emulate.
 */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue; // a specifier pointing at nothing is the compiler's problem, not this test's
    }
    for (const spec of importSpecifiers(src)) {
      if (!spec.startsWith(".")) continue;
      queue.push(resolve(dirname(file), spec));
    }
  }
  return seen;
}

/**
 * Unreachable code is dead code, and dead code lies.
 *
 * pi-git shipped `src/git.ts` and `src/worktrees.ts` — a worktree capability reachable
 * from nothing but its own test, while a `worktrees` config block and two `/pi-git`
 * settings rows advertised it to users as a real feature. It survived a full contract
 * test suite because that suite checked tools, commands, and events, and this was none
 * of those.
 *
 * It matters more now that extensions are meant to be replaceable: a replacement that
 * leaves its predecessor's modules behind should fail loudly, not accumulate.
 */
for (const ext of EXTENSION_DIRS) {
  test(`[${ext}] every module under src/ is reachable from index.ts`, () => {
    const reached = reachableFrom(join(ROOT, ext, "index.ts"));
    const orphans = allTsFiles(ext)
      .filter((f) => !f.includes("/test/") && f !== join(ROOT, ext, "index.ts"))
      .filter((f) => !reached.has(f))
      .map((f) => relative(ROOT, f));
    expect(orphans).toEqual([]);
  });
}

test("the reachability walk actually follows imports, and would flag an orphan", () => {
  // Guards the guard. `git/index.ts` reaches its store through `./src/store.ts`…
  const reached = reachableFrom(join(ROOT, "git/index.ts"));
  expect(reached.has(join(ROOT, "git/src/store.ts"))).toBe(true);
  // …and transitively, through store.ts, the shared config module.
  expect(reached.has(join(ROOT, "shared/config.ts"))).toBe(true);
  // A file nothing imports is not reached — which is what makes the check above real.
  expect(reached.has(join(ROOT, "git/src/nonexistent-orphan.ts"))).toBe(false);
});

// ---------------------------------------------------------------------------
// cwd resolution is centralised.
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

// ---------------------------------------------------------------------------
// One implementation per concept.
//
// Every duplication this suite has produced followed the same course: a helper small
// enough to retype rather than import, copied to a second site, then missed at a third —
// and each miss was a live defect. `process.cwd()` above is the original instance; these
// are the ones found alongside it. A scan is crude, but it fails at the moment the
// second copy is written rather than weeks later.
// ---------------------------------------------------------------------------

/** Source with comments stripped, so prose explaining a rule never trips it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

interface SingleSource {
  what: string;
  /** The pattern that identifies an implementation. */
  re: RegExp;
  /** The one file permitted to contain it, repo-relative. */
  home: string;
  fix: string;
}

const SINGLE_SOURCE: SingleSource[] = [
  {
    what: "a frontmatter parser",
    re: /---\\r\?\\n/,
    home: "shared/frontmatter.ts",
    fix: "call parseFrontmatter()",
  },
  {
    what: "a 31-multiply string hash",
    re: /\*\s*31\s*\+/,
    home: "shared/hash.ts",
    fix: "call stableHash()",
  },
  {
    what: "a read of PI_CODING_AGENT_DIR",
    re: /PI_CODING_AGENT_DIR/,
    home: "shared/config.ts",
    fix: "call agentDir()",
  },
];

for (const rule of SINGLE_SOURCE) {
  test(`${rule.what} exists only in ${rule.home}`, () => {
    const offenders: string[] = [];
    for (const dir of [...EXTENSION_DIRS, "shared"]) {
      for (const file of allTsFiles(dir)) {
        const rel = relative(ROOT, file);
        if (rel === rule.home) continue;
        if (rel.includes("/test/")) continue; // tests legitimately construct fixtures
        if (rule.re.test(code(readFileSync(file, "utf8")))) {
          offenders.push(`${rel}: has ${rule.what} — ${rule.fix}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
}

test("the single-source patterns actually match the thing they describe", () => {
  // Guards the guards: three checkers that can never fail are not checkers.
  const [frontmatter, hash, agentDir] = SINGLE_SOURCE as [SingleSource, SingleSource, SingleSource];
  expect(frontmatter.re.test(String.raw`text.match(/^---\r?\n([\s\S]*?)---/)`)).toBe(true);
  expect(hash.re.test("h = (h * 31 + s.charCodeAt(i)) | 0;")).toBe(true);
  expect(agentDir.re.test('process.env.PI_CODING_AGENT_DIR ?? "x"')).toBe(true);
  // And that each one's home really does contain it, so a rename cannot leave the rule
  // passing vacuously against a file that no longer holds the implementation.
  for (const rule of SINGLE_SOURCE) {
    expect(rule.re.test(readFileSync(join(ROOT, rule.home), "utf8"))).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Import hygiene.
// ---------------------------------------------------------------------------

/** Specifiers imported more than once by the same file. */
function duplicateImports(src: string): string[] {
  const seen = new Map<string, number>();
  for (const spec of importSpecifiers(src)) seen.set(spec, (seen.get(spec) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([spec]) => spec);
}

test("no file imports the same specifier twice", () => {
  // Nine files did, most of them splitting a type import from a value import of the same
  // module. Harmless individually, but it is the visible end of the copy-paste habit
  // that produced everything the guards above exist for.
  const offenders: string[] = [];
  for (const dir of [...EXTENSION_DIRS, "shared", "test"]) {
    for (const file of allTsFiles(dir)) {
      const rel = relative(ROOT, file);
      // The barrel re-exports each module twice by necessity: `verbatimModuleSyntax`
      // requires `export type { … }` to be a separate statement from `export { … }`.
      if (rel === "shared/index.ts") continue;
      for (const spec of duplicateImports(readFileSync(file, "utf8"))) {
        offenders.push(`${rel}: imports "${spec}" more than once`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("the duplicate-import checker actually detects a duplicate", () => {
  // Guards the guard.
  expect(duplicateImports('import type { A } from "./x.ts";\nimport { b } from "./x.ts";')).toEqual([
    "./x.ts",
  ]);
  expect(duplicateImports('import { A, b } from "./x.ts";')).toEqual([]);
  expect(duplicateImports('import { a } from "./x.ts";\nimport { b } from "./y.ts";')).toEqual([]);
});

// ---------------------------------------------------------------------------
// Extension shape.
//
// Extensions are peers: any one can be replaced by writing a new directory with the
// same shape. That is only true if the shape is actually uniform, so it is checked
// rather than described.
// ---------------------------------------------------------------------------

for (const ext of EXTENSION_DIRS) {
  test(`[${ext}] has the standard extension layout`, () => {
    const missing: string[] = [];
    for (const entry of ["index.ts", "src", "test", "README.md"]) {
      if (!existsSync(join(ROOT, ext, entry))) missing.push(entry);
    }
    expect(missing).toEqual([]);
  });

  test(`[${ext}] default-exports a factory taking the extension API`, () => {
    // Pi calls this; a module that exported something else would fail at load, which is
    // far from where the mistake was made.
    const src = readFileSync(join(ROOT, ext, "index.ts"), "utf8");
    expect(src).toMatch(/export default function \w+\(\s*pi\s*:/);
  });
}
