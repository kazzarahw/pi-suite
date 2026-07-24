import { test, expect } from "bun:test";
import { scanSecrets } from "../src/secrets.ts";

test("scanSecrets flags obvious keys and tokens", () => {
  expect(scanSecrets("key = sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234").map((f) => f.kind)).toContain("anthropic-key");
  expect(scanSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345").map((f) => f.kind)).toContain("bearer-token");
  expect(scanSecrets("aws AKIAIOSFODNN7EXAMPLE stuff").map((f) => f.kind)).toContain("aws-access-key");
});

test("scanSecrets ignores ordinary prose", () => {
  expect(scanSecrets("The user prefers concise answers and tabs over spaces.")).toEqual([]);
});

test("scanSecrets truncates the reported match (never echoes the full secret)", () => {
  const f = scanSecrets("sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234");
  expect(f).toHaveLength(1);
  expect(f[0]!.match.length).toBeLessThanOrEqual(11);
  expect(f[0]!.match).not.toContain("wxyz1234");
});
