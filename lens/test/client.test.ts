import { test, expect } from "bun:test";
import { createLspClient, LspUnavailableError, stripCodeFences } from "../src/lsp/client.ts";
import { within } from "../../shared/test/harness.ts";
import { deadline } from "../../shared/index.ts";
import { encodeMessage, decodeMessages } from "../src/lsp/framing.ts";

function fakeIo() {
  const sent: Array<Record<string, unknown>> = [];
  let onData: (s: string) => void = () => {};
  const io = {
    write: (s: string) => {
      for (const m of decodeMessages(s).messages) sent.push(m as Record<string, unknown>);
    },
    onData: (cb: (s: string) => void) => {
      onData = cb;
    },
  };
  return { io, sent, feed: (obj: unknown) => onData(encodeMessage(obj)) };
}

test("initialize sends the init handshake then 'initialized'", async () => {
  const { io, sent, feed } = fakeIo();
  const client = createLspClient(io);
  const p = client.initialize("file:///proj");
  feed({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
  await p;
  expect(sent[0]!.method).toBe("initialize");
  expect(sent.some((m) => m.method === "initialized")).toBe(true);
});

test("publishDiagnostics surfaces via onDiagnostics as normalized Diagnostic[] (1-based)", () => {
  const { io, feed } = fakeIo();
  const client = createLspClient(io);
  let got: { uri: string; ds: unknown } | null = null;
  client.onDiagnostics((uri, ds) => {
    got = { uri, ds };
  });
  feed({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: "file:///proj/a.ts",
      diagnostics: [
        { range: { start: { line: 4, character: 8 } }, severity: 1, message: "Cannot find name 'x'.", source: "ts", code: 2304 },
      ],
    },
  });
  expect(got!.ds).toEqual([
    { file: "/proj/a.ts", line: 5, col: 9, severity: "error", message: "Cannot find name 'x'.", source: "ts", code: "2304" },
  ]);
});

test("hover resolves with the server's reply", async () => {
  const { io, sent, feed } = fakeIo();
  const client = createLspClient(io);
  const p = client.hover("file:///a.ts", { line: 1, col: 1 });
  const req = sent.find((m) => m.method === "textDocument/hover") as { id: number };
  feed({ jsonrpc: "2.0", id: req.id, result: { contents: { kind: "markdown", value: "const x: number" } } });
  expect(await p).toBe("const x: number");
});

// --- Bounded requests ------------------------------------------------------
// The P0. `request()` resolved only on a matching JSON-RPC id: no timeout, no reject
// path, no abort handling. A wedged or dead server left hover/references/definition/
// rename pending forever, and Esc could not cancel because the tool discarded its
// signal. An earlier fix (a `which` check plus an onDead handler) landed at the spawn
// layer and left the request itself unbounded.
//
// Every test here goes through within() so a regression fails the test instead of
// stopping the whole run.

test("a request that is never answered rejects at its deadline", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 20 });
  const err = await within(2000, client.hover("file:///a.ts", { line: 1, col: 1 }).catch((e: unknown) => e));
  expect(err).toBeInstanceOf(LspUnavailableError);
  expect((err as LspUnavailableError).reason).toBe("timeout");
  expect((err as LspUnavailableError).method).toBe("textDocument/hover");
});

test("a timeout does not leave the pending entry behind", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 20 });
  await within(2000, client.references("file:///a.ts", { line: 1, col: 1 }).catch(() => {}));
  expect(client.pendingCount()).toBe(0);
});

// The hole the previous fix left: onDead settled `warm` but never touched `pending`,
// so a server dying mid-query left that promise unsettled forever.
test("dispose rejects every in-flight request", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 10_000 });
  const a = client.hover("file:///a.ts", { line: 1, col: 1 }).catch((e: unknown) => e);
  const b = client.definition("file:///b.ts", { line: 1, col: 1 }).catch((e: unknown) => e);
  client.dispose("server exited");
  const [ea, eb] = await within(2000, Promise.all([a, b]));
  for (const e of [ea, eb]) {
    expect(e).toBeInstanceOf(LspUnavailableError);
    expect((e as LspUnavailableError).reason).toBe("disposed");
  }
  expect(client.pendingCount()).toBe(0);
});

test("aborting the passed signal rejects the request promptly", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 10_000 });
  const ac = new AbortController();
  const p = client.references("file:///a.ts", { line: 1, col: 1 }, ac.signal).catch((e: unknown) => e);
  ac.abort();
  const err = await within(2000, p);
  expect(err).toBeInstanceOf(LspUnavailableError);
  expect(client.pendingCount()).toBe(0);
});

test("an already-aborted signal rejects without waiting for the deadline", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 10_000 });
  const err = await within(
    2000,
    client.definition("file:///a.ts", { line: 1, col: 1 }, AbortSignal.abort()).catch((e: unknown) => e),
  );
  expect(err).toBeInstanceOf(LspUnavailableError);
});

// A caller-supplied deadline and a user pressing Esc both arrive as an abort, and
// calling both "aborted" tells the agent someone cancelled when the truth is a server
// that never replied — the same defect as answering with "(none found)". A live run
// against a wedged typescript-language-server reported "aborted"; this is what caught it.
test("a deadline on the caller's signal reports a timeout, not a cancellation", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 10_000 });
  const err = (await within(
    2000,
    client.references("file:///a.ts", { line: 1, col: 1 }, deadline(20)).catch((e: unknown) => e),
  )) as LspUnavailableError;

  expect(err).toBeInstanceOf(LspUnavailableError);
  expect(err.reason).toBe("timeout");
  expect(err.message).toContain("did not respond");
  expect(client.pendingCount()).toBe(0);
});

test("a user abort still reports as a cancellation", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 10_000 });
  const ac = new AbortController();
  const p = client.references("file:///a.ts", { line: 1, col: 1 }, ac.signal).catch((e: unknown) => e);
  ac.abort();
  const err = (await within(2000, p)) as LspUnavailableError;

  expect(err.reason).toBe("disposed");
  expect(err.message).toContain("aborted");
});

test("a normal reply still resolves and clears its pending entry", async () => {
  const { io, sent, feed } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 5000 });
  const p = client.hover("file:///a.ts", { line: 1, col: 1 });
  const req = sent.find((m) => m.method === "textDocument/hover") as { id: number };
  feed({ jsonrpc: "2.0", id: req.id, result: { contents: "docs" } });
  expect(await within(2000, p)).toBe("docs");
  expect(client.pendingCount()).toBe(0);
});

// A JSON-RPC *error* reply is a real answer: the server responded and has nothing.
// Only bounded waits reject — otherwise every "no symbol here" becomes an error.
test("a JSON-RPC error reply still resolves rather than rejecting", async () => {
  const { io, sent, feed } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 5000 });
  const p = client.references("file:///a.ts", { line: 1, col: 1 });
  const req = sent.find((m) => m.method === "textDocument/references") as { id: number };
  feed({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Unhandled method" } });
  expect(await within(2000, p)).toEqual([]);
});

// Distinguishing "slow" from "empty" is the whole point: resolving null here would
// render as "(none found)" and the agent would act on a confident wrong answer.
test("a wedged server does not look like an empty result", async () => {
  const { io } = fakeIo();
  const client = createLspClient(io, { requestTimeoutMs: 20 });
  const out = await within(2000, client.references("file:///a.ts", { line: 1, col: 1 }).catch((e: unknown) => e));
  expect(Array.isArray(out)).toBe(false);
});

/**
 * A hover is markdown and Pi prints a tool result's text verbatim, so every fence
 * delimiter would otherwise reach the transcript as literal backticks.
 */
test("a hover that is nothing but a code fence keeps only the code", () => {
  expect(stripCodeFences("```typescript\nfunction greet(name: string): string\n```")).toBe(
    "function greet(name: string): string",
  );
  expect(stripCodeFences("```\nplain\n```")).toBe("plain");
  expect(stripCodeFences("```c++\nint x;\n```")).toBe("int x;");
});

/**
 * The case that made the rule: with nothing rendering the markdown, a fence between a
 * signature and its JSDoc separates nothing. The blank line already does that.
 */
test("a hover mixing code and prose keeps both, in order, without delimiters", () => {
  expect(
    stripCodeFences("```typescript\nfunction greet(n: string): string\n```\n\nGreets somebody."),
  ).toBe("function greet(n: string): string\n\nGreets somebody.");
});

test("several fenced blocks all survive as content", () => {
  expect(stripCodeFences("```ts\na\n```\n```ts\nb\n```")).toBe("a\nb");
});

test("text with no fence at all is returned untouched", () => {
  expect(stripCodeFences("just a sentence")).toBe("just a sentence");
  expect(stripCodeFences("")).toBe("");
});
