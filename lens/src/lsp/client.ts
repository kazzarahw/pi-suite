import { encodeMessage, decodeMessages } from "./framing.ts";
import type { Diagnostic, Location, Position } from "../diagnostics.ts";

export interface RenameEdit {
  file: string;
  edits: unknown[];
}

export interface LspClient {
  initialize(rootUri: string): Promise<void>;
  didOpen(uri: string, text: string, languageId: string): void;
  didChange(uri: string, text: string): void;
  onDiagnostics(cb: (uri: string, ds: Diagnostic[]) => void): void;
  hover(uri: string, pos: Position): Promise<string | null>;
  rename(uri: string, pos: Position, newName: string): Promise<RenameEdit[]>;
  references(uri: string, pos: Position): Promise<Location[]>;
  definition(uri: string, pos: Position): Promise<Location[]>;
  shutdown(): Promise<void>;
}

export interface LspIO {
  write: (s: string) => void;
  onData: (cb: (s: string) => void) => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- LSP wire messages are loosely typed */
type Any = any;

const SEVERITY: Record<number, Diagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "info" };

export function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}
const toLspPos = (p: Position) => ({ line: p.line - 1, character: p.col - 1 });
const rangeStart = (range: Any): { line: number; col: number } => ({
  line: (range?.start?.line ?? 0) + 1,
  col: (range?.start?.character ?? 0) + 1,
});

function normalizeDiag(uri: string, d: Any): Diagnostic {
  const start = rangeStart(d.range);
  return {
    file: uriToPath(uri),
    line: start.line,
    col: start.col,
    severity: SEVERITY[d.severity] ?? "info",
    message: String(d.message ?? "").split("\n")[0]!,
    source: d.source ? String(d.source) : "lsp",
    code: d.code != null ? String(d.code) : undefined,
  };
}

function extractHover(result: Any): string | null {
  const c = result?.contents;
  if (!c) return null;
  if (typeof c === "string") return c.trim() || null;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x?.value ?? ""))).join("\n").trim() || null;
  if (typeof c.value === "string") return c.value.trim() || null;
  return null;
}

function toLocations(result: Any): Location[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr
    .filter((l: Any) => l && (l.uri || l.targetUri))
    .map((l: Any) => {
      const { line, col } = rangeStart(l.range ?? l.targetSelectionRange ?? l.targetRange);
      return { file: uriToPath(l.uri ?? l.targetUri), line, col };
    });
}

function toRenameEdits(result: Any): RenameEdit[] {
  if (result?.changes) {
    return Object.entries(result.changes).map(([uri, edits]) => ({ file: uriToPath(uri), edits: edits as unknown[] }));
  }
  if (Array.isArray(result?.documentChanges)) {
    return result.documentChanges
      .filter((x: Any) => x.textDocument)
      .map((x: Any) => ({ file: uriToPath(x.textDocument.uri), edits: x.edits ?? [] }));
  }
  return [];
}

/** A single LSP-server conversation over injectable stdio. */
export function createLspClient(io: LspIO): LspClient {
  let nextId = 1;
  const pending = new Map<number, (result: Any) => void>();
  const versions = new Map<string, number>();
  let diagCb: (uri: string, ds: Diagnostic[]) => void = () => {};
  let buffer = "";

  io.onData((chunk) => {
    buffer += chunk;
    const { messages, rest } = decodeMessages(buffer);
    buffer = rest;
    for (const msg of messages) handle(msg as Any);
  });

  function handle(msg: Any): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg.error ? null : msg.result);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const ds = (msg.params?.diagnostics ?? []).map((d: Any) => normalizeDiag(msg.params.uri, d));
      diagCb(msg.params.uri, ds);
      return;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      // Server->client request: reply null so it doesn't block the conversation.
      io.write(encodeMessage({ jsonrpc: "2.0", id: msg.id, result: null }));
    }
  }

  const request = (method: string, params: unknown): Promise<Any> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      io.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  };
  const notify = (method: string, params: unknown): void => {
    io.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  };

  return {
    async initialize(rootUri) {
      await request("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: { publishDiagnostics: {}, hover: {}, references: {}, definition: {}, rename: {} },
        },
        workspaceFolders: null,
      });
      notify("initialized", {});
    },
    didOpen(uri, text, languageId) {
      versions.set(uri, 1);
      notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    },
    didChange(uri, text) {
      const v = (versions.get(uri) ?? 1) + 1;
      versions.set(uri, v);
      notify("textDocument/didChange", { textDocument: { uri, version: v }, contentChanges: [{ text }] });
    },
    onDiagnostics(cb) {
      diagCb = cb;
    },
    async hover(uri, pos) {
      return extractHover(await request("textDocument/hover", { textDocument: { uri }, position: toLspPos(pos) }));
    },
    async references(uri, pos) {
      return toLocations(
        await request("textDocument/references", {
          textDocument: { uri },
          position: toLspPos(pos),
          context: { includeDeclaration: true },
        }),
      );
    },
    async definition(uri, pos) {
      return toLocations(
        await request("textDocument/definition", { textDocument: { uri }, position: toLspPos(pos) }),
      );
    },
    async rename(uri, pos, newName) {
      return toRenameEdits(
        await request("textDocument/rename", { textDocument: { uri }, position: toLspPos(pos), newName }),
      );
    },
    async shutdown() {
      await request("shutdown", null);
      notify("exit", null);
    },
  };
}
