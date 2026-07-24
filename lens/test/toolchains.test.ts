import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toolchainFor,
  lspServers,
  runFormatter,
  PRETTIER,
  RUFF_FORMAT,
  GOFMT,
} from "../src/toolchains.ts";
import type { ExecFn } from "../src/exec.ts";

test("toolchainFor resolves known extensions with lsp + linters + formatter", () => {
  const ts = toolchainFor("src/a.ts");
  expect(ts?.lsp?.command).toEqual(["typescript-language-server", "--stdio"]);
  expect(ts?.lsp?.languageId).toBe("typescript");
  expect(ts?.linters.map((l) => l.name)).toEqual(["eslint"]);
  expect(ts?.formatter?.name).toBe("prettier");

  const py = toolchainFor("x.py");
  expect(py?.lsp?.command[0]).toBe("pyright-langserver");
  expect(py?.linters.map((l) => l.name)).toEqual(["ruff"]);
  expect(py?.formatter?.name).toBe("ruff format");
});

test("toolchainFor returns null for unknown / extension-less files", () => {
  expect(toolchainFor("a.xyz")).toBeNull();
  expect(toolchainFor("Makefile")).toBeNull();
});

test("toolchainFor applies per-ext overrides over the defaults", () => {
  const tc = toolchainFor("a.ts", {
    ts: { formatter: { name: "biome", cmd: (f) => ["biome", "format", "--write", f] } },
  });
  expect(tc?.formatter?.name).toBe("biome");
  expect(tc?.lsp?.command[0]).toBe("typescript-language-server"); // base preserved
});

test("lspServers derives the ext->server map and omits no-LSP languages", () => {
  const servers = lspServers();
  expect(servers.ts?.command[0]).toBe("typescript-language-server");
  expect(servers.go?.command).toEqual(["gopls"]);
  expect(servers.py?.command[0]).toBe("pyright-langserver");
  expect(servers.md).toBeUndefined(); // markdown ships a formatter but no LSP
});

test("formatter specs build correct in-place argv", () => {
  expect(PRETTIER.cmd("a.ts")).toEqual(["prettier", "--write", "a.ts"]);
  expect(RUFF_FORMAT.cmd("a.py")).toEqual(["ruff", "format", "a.py"]);
  expect(GOFMT.cmd("a.go")).toEqual(["gofmt", "-w", "a.go"]);
});

test("runFormatter reports changed=true when the formatter rewrites the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lens-fmt-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, "const x=1\n");
  const exec: ExecFn = async () => {
    writeFileSync(file, "const x = 1;\n"); // simulate prettier's in-place rewrite
    return { stdout: "", stderr: "", code: 0 };
  };
  expect(await runFormatter(file, PRETTIER, exec)).toEqual({ changed: true });
  expect(readFileSync(file, "utf8")).toBe("const x = 1;\n");
  rmSync(dir, { recursive: true, force: true });
});

test("runFormatter reports changed=false on a no-op format", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lens-fmt-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, "const x = 1;\n");
  const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
  expect(await runFormatter(file, PRETTIER, exec)).toEqual({ changed: false });
  rmSync(dir, { recursive: true, force: true });
});

test("runFormatter reports changed=false when the formatter exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lens-fmt-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, "oops(\n");
  const exec: ExecFn = async () => {
    writeFileSync(file, "SHOULD BE IGNORED\n");
    return { stdout: "", stderr: "parse error", code: 2 };
  };
  expect(await runFormatter(file, PRETTIER, exec)).toEqual({ changed: false });
  rmSync(dir, { recursive: true, force: true });
});
