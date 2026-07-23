import { test, expect } from "bun:test";
import { encodeMessage, decodeMessages } from "../src/lsp/framing.ts";

test("encodeMessage emits a correct Content-Length header (bytes)", () => {
  expect(encodeMessage({ a: 1 })).toBe(`Content-Length: 7\r\n\r\n{"a":1}`);
});

test("decodeMessages parses one, multiple, and partial buffers", () => {
  const a = encodeMessage({ id: 1 });
  const b = encodeMessage({ id: 2 });

  expect(decodeMessages(a)).toEqual({ messages: [{ id: 1 }], rest: "" });
  expect(decodeMessages(a + b).messages).toEqual([{ id: 1 }, { id: 2 }]);

  const partial = a + b.slice(0, 10);
  const r = decodeMessages(partial);
  expect(r.messages).toEqual([{ id: 1 }]);
  expect(r.rest).toBe(b.slice(0, 10));
});
