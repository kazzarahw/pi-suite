import { test, expect } from "bun:test";
import { probeAvailability, formatHealth } from "../src/health.ts";
import { DEFAULT_TOOLCHAINS } from "../src/toolchains.ts";

test("probeAvailability probes each distinct tool binary exactly once", () => {
  const seen: string[] = [];
  const present = new Set(["typescript-language-server", "ruff", "prettier"]);
  const which = (bin: string) => {
    seen.push(bin);
    return present.has(bin);
  };
  const statuses = probeAvailability(DEFAULT_TOOLCHAINS, which);
  expect(new Set(seen).size).toBe(seen.length); // no binary probed twice
  const byBin = Object.fromEntries(statuses.map((s) => [s.bin, s.available]));
  expect(byBin["typescript-language-server"]).toBe(true);
  expect(byBin["ruff"]).toBe(true);
  expect(byBin["gopls"]).toBe(false);
  expect(byBin["rust-analyzer"]).toBe(false);
});

test("formatHealth lists available then missing, each sorted", () => {
  const line = formatHealth([
    { bin: "ruff", available: true },
    { bin: "gopls", available: false },
    { bin: "prettier", available: true },
    { bin: "shellcheck", available: false },
  ]);
  expect(line).toBe("tools available: prettier, ruff · missing: gopls, shellcheck");
});

test("formatHealth omits the missing clause when nothing is missing", () => {
  expect(formatHealth([{ bin: "ruff", available: true }])).toBe("tools available: ruff");
});
