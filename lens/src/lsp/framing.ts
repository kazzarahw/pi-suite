/**
 * LSP wire framing: `Content-Length: N\r\n\r\n<json>`. Content-Length is in BYTES,
 * so decode works over a Buffer to stay correct with non-ASCII payloads. Pure.
 */

export function encodeMessage(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

/** Pull all complete messages out of an accumulated buffer; return them + the leftover `rest`. */
export function decodeMessages(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let buf = Buffer.from(buffer, "utf8");

  while (true) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) break;
    const header = buf.subarray(0, sep).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      // Unrecognizable header — skip past this separator to resync.
      buf = buf.subarray(sep + 4);
      continue;
    }
    const len = Number(m[1]);
    const bodyStart = sep + 4;
    if (buf.length < bodyStart + len) break; // incomplete message
    const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
    try {
      messages.push(JSON.parse(body));
    } catch {
      /* skip malformed body */
    }
    buf = buf.subarray(bodyStart + len);
  }

  return { messages, rest: buf.toString("utf8") };
}
