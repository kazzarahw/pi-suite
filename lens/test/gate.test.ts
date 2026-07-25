import { test, expect } from "bun:test";
import { createVerifyGate } from "../src/gate.ts";

/**
 * The verify gate — when a settle should run the test command.
 *
 * This was three module-level booleans in `lens/index.ts`, written by the `tool_result`
 * hook and read by `agent_settled`. The policy was never wrong, but reaching it meant
 * driving two hooks in order with the right fake context, so it was covered only
 * incidentally and those exact lines were the file's coverage gap.
 */

const ERROR = [{ severity: "error" }];
const WARNING = [{ severity: "warning" }];
const CLEAN: Array<{ severity: string }> = [];

test("a fresh gate does not verify — nothing has been edited", () => {
  expect(createVerifyGate().shouldVerify()).toBe(false);
});

test("a clean edit opens the gate", () => {
  const gate = createVerifyGate();
  gate.noteDiagnostics(CLEAN, true);
  expect(gate.shouldVerify()).toBe(true);
});

test("an edit with errors keeps it shut", () => {
  // Running the suite against code that does not parse spends a test run to report what
  // the diagnostics already said.
  const gate = createVerifyGate();
  gate.noteDiagnostics(ERROR, true);
  expect(gate.shouldVerify()).toBe(false);
});

test("warnings do not hold it shut — only errors do", () => {
  const gate = createVerifyGate();
  gate.noteDiagnostics(WARNING, true);
  expect(gate.shouldVerify()).toBe(true);
});

test("a read alone never opens it", () => {
  const gate = createVerifyGate();
  gate.noteDiagnostics(CLEAN, false);
  expect(gate.shouldVerify()).toBe(false);
});

test("a clean read after an edit does not cancel the pending verify", () => {
  // The agent frequently reads a neighbouring file between editing and settling. `dirty`
  // must survive that; only a verify may clear it.
  const gate = createVerifyGate();
  gate.noteDiagnostics(CLEAN, true);
  gate.noteDiagnostics(CLEAN, false);
  expect(gate.shouldVerify()).toBe(true);
});

test("errors found by a later read do hold the gate shut", () => {
  // Severity always reflects the most recent check, edit or read: the file is broken
  // now, whoever noticed.
  const gate = createVerifyGate();
  gate.noteDiagnostics(CLEAN, true);
  gate.noteDiagnostics(ERROR, false);
  expect(gate.shouldVerify()).toBe(false);
});

test("fixing the errors reopens the gate without a further edit", () => {
  const gate = createVerifyGate();
  gate.noteDiagnostics(ERROR, true);
  expect(gate.shouldVerify()).toBe(false);
  gate.noteDiagnostics(CLEAN, true);
  expect(gate.shouldVerify()).toBe(true);
});

test("consume closes the gate, so one settle verifies once", () => {
  const gate = createVerifyGate();
  gate.noteDiagnostics(CLEAN, true);
  gate.consume();
  expect(gate.shouldVerify()).toBe(false);
});

test("a new edit after a verify reopens it", () => {
  const gate = createVerifyGate();
  gate.noteDiagnostics(CLEAN, true);
  gate.consume();
  gate.noteDiagnostics(CLEAN, true);
  expect(gate.shouldVerify()).toBe(true);
});

test("warnOnce is true exactly once", () => {
  // A skip notice repeated on every settle is noise a user learns to ignore.
  const gate = createVerifyGate();
  expect(gate.warnOnce()).toBe(true);
  expect(gate.warnOnce()).toBe(false);
  expect(gate.warnOnce()).toBe(false);
});

test("each gate carries its own state", () => {
  const a = createVerifyGate();
  const b = createVerifyGate();
  a.noteDiagnostics(CLEAN, true);
  a.warnOnce();
  expect(b.shouldVerify()).toBe(false);
  expect(b.warnOnce()).toBe(true);
});
