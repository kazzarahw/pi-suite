import { test, expect } from "bun:test";
import {
  approvalQuestion,
  describeToolCall,
  needsApproval,
  readVerdict,
  refusalReason,
  WRITE_TOOLS,
} from "../src/approve.ts";

test("off approves nothing by asking nothing", () => {
  for (const tool of ["bash", "write", "read"]) expect(needsApproval("off", tool)).toBe(false);
});

test("all covers every tool, including the harmless ones", () => {
  for (const tool of ["bash", "write", "read", "grep"]) expect(needsApproval("all", tool)).toBe(true);
});

/**
 * `writes` has to include `bash`, and that is the point of composing the set from
 * `shared/tool-input.ts` rather than listing it here.
 *
 * pi-plan's edit gate documents at length that it cannot see a write through bash — a `sed -i`, a
 * heredoc, a `>` redirect. An approval gate with the same blind spot would ask about the careful
 * half of the work and wave through `rm -rf`.
 */
test("writes covers the tools that change something, bash included", () => {
  for (const tool of ["write", "edit", "bash"]) expect(needsApproval("writes", tool)).toBe(true);
  for (const tool of ["read", "grep", "find", "ls"]) expect(needsApproval("writes", tool)).toBe(false);
  expect([...WRITE_TOOLS].sort()).toEqual(["bash", "edit", "write"]);
});

// ---------------------------------------------------------------------------
// The question. Someone reading it on a phone has no transcript to look at.
// ---------------------------------------------------------------------------

test("the payload is in the question, not just the tool name", () => {
  expect(describeToolCall({ command: "bun test" })).toBe("bun test");
  // Both spellings of the path key, which is why `editedPath` is shared.
  expect(describeToolCall({ path: "README.md" })).toBe("README.md");
  expect(describeToolCall({ file_path: "src/index.ts" })).toBe("src/index.ts");
  expect(describeToolCall({ pattern: "TODO" })).toBe("TODO");
  expect(describeToolCall({})).toBe("(no details)");
  expect(describeToolCall(undefined)).toBe("(no details)");
});

test("a long command is clipped rather than sent whole", () => {
  const detail = describeToolCall({ command: "x".repeat(500) });
  expect(detail.length).toBeLessThan(400);
  expect(detail.endsWith("…")).toBe(true);
});

test("the question names the tool, the payload, and how to answer", () => {
  const q = approvalQuestion("bash", { command: "rm -rf build" });
  expect(q).toContain("bash");
  expect(q).toContain("rm -rf build");
  expect(q).toContain("yes");
});

// ---------------------------------------------------------------------------
// Reading the answer. A gate that treats silence as consent is not a gate.
// ---------------------------------------------------------------------------

test("only a clear yes approves", () => {
  for (const yes of ["yes", "y", "Yes", " OK ", "sure", "allow", "approve", "yes."]) {
    expect(readVerdict(yes)).toBe("approved");
  }
});

test("no answer, and an unclear answer, are told apart but both refuse", () => {
  expect(readVerdict(null)).toBe("unanswered");
  expect(readVerdict("no")).toBe("denied");
  expect(readVerdict("nope")).toBe("denied");
  // The case that matters most: a message meant as steering is not an approval.
  expect(readVerdict("wait, use the other branch")).toBe("unclear");
  expect(readVerdict("")).toBe("unclear");
});

test("nothing but an exact yes gets through, however agreeable it sounds", () => {
  for (const notYes of ["yes but not that file", "yeah maybe", "y/n", "affirmative"]) {
    expect(readVerdict(notYes)).not.toBe("approved");
  }
});

// ---------------------------------------------------------------------------
// The refusal. Leads with the outcome, per plan/src/gate.ts and the dogfooding behind it.
// ---------------------------------------------------------------------------

test("every refusal says first that the call did not run", () => {
  for (const verdict of ["denied", "unclear", "unanswered"] as const) {
    const reason = refusalReason("write", verdict, verdict === "unclear" ? "hold on" : null);
    expect(reason).toContain("[pi-telegram]");
    expect(reason).toContain("did NOT run");
    expect(reason).toContain("nothing was changed");
  }
});

/**
 * An unclear answer is quoted back, because it is usually an instruction.
 *
 * Someone who replies "not that file, do the other one" is steering, not answering. The gate
 * still refuses — it is not an approval — but throwing the text away would lose the only useful
 * thing in the exchange.
 */
test("an unclear answer reaches the agent as what was actually said", () => {
  const reason = refusalReason("edit", "unclear", "not that file, do src/b.ts");
  expect(reason).toContain("not that file, do src/b.ts");
  expect(reason).toContain("not an approval");
});

test("a denial tells the agent not to retry, and a timeout tells it to wait", () => {
  expect(refusalReason("bash", "denied", "no")).toContain("Do not retry");
  expect(refusalReason("bash", "unanswered", null)).toContain("wait");
});
