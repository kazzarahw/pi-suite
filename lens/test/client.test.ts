import { test, expect } from "bun:test";
import { createLspClient } from "../src/lsp/client.ts";
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
