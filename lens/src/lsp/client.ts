import { encodeMessage, decodeMessages } from "./framing.ts";
import type { Diagnostic, Location, Position } from "../diagnostics.ts";

export interface RenameEdit {
  file: string;
  edits: unknown[];
}

/**
 * A request could not be answered — the server exceeded its deadline, died, or the
 * caller aborted.
 *
 * This **rejects** rather than resolving empty on purpose. `request()` maps a
 * JSON-RPC *error* reply to `null`, and the converters below turn `null` into `[]`
 * or "(no hover info)". If a timeout took that path, `references` against a wedged
 * server would report "(none found)" — a confident wrong answer the agent then acts
 * on. Distinguishing "slow" from "empty" is the entire point.
 */
export class LspUnavailableError extends Error {
  constructor(
    readonly reason: "timeout" | "disposed",
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = "LspUnavailableError";
  }
}

/** Default ceiling for a single request. `ready()` already waits out project load. */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface LspClientOptions {
  /** Per-request deadline. Injected in tests; production uses REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

export interface LspClient {
  initialize(rootUri: string, signal?: AbortSignal): Promise<void>;
  didOpen(uri: string, text: string, languageId: string): void;
  didChange(uri: string, text: string): void;
  onDiagnostics(cb: (uri: string, ds: Diagnostic[]) => void): void;
  hover(uri: string, pos: Position, signal?: AbortSignal): Promise<string | null>;
  rename(uri: string, pos: Position, newName: string, signal?: AbortSignal): Promise<RenameEdit[]>;
  references(uri: string, pos: Position, signal?: AbortSignal): Promise<Location[]>;
  definition(uri: string, pos: Position, signal?: AbortSignal): Promise<Location[]>;
  shutdown(): Promise<void>;
  /**
   * Reject every in-flight request. Called when the server process dies — otherwise
   * those promises never settle, which is the hole the spawn-layer fix left open.
   */
  dispose(reason: string): void;
  /** In-flight request count. Exposed so tests can prove entries are not leaked. */
  pendingCount(): number;
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

/** One in-flight request: how to settle it, and how to stop its timer. */
interface Pending {
  resolve: (result: Any) => void;
  reject: (err: Error) => void;
  cancel: () => void;
  method: string;
}

/** A single LSP-server conversation over injectable stdio. */
export function createLspClient(io: LspIO, opts: LspClientOptions = {}): LspClient {
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  let nextId = 1;
  const pending = new Map<number, Pending>();
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
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        entry.cancel();
        // A JSON-RPC error is a real answer — the server responded and has nothing.
        // Only bounded waits reject; see LspUnavailableError.
        entry.resolve(msg.error ? null : msg.result);
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

  /**
   * Send a request and wait for its reply — bounded.
   *
   * The bound lives here, not in the manager or the tool, because this is the only
   * scope holding both the `pending` map and the request id: the only place that can
   * settle the promise *and* remove its entry. A previous attempt bounded process
   * spawning one layer up, which prevented spawning an absent binary and left the
   * request itself unbounded. Bound the await where its state lives.
   *
   * Three paths can settle a request — reply, deadline, abort — and whichever fires
   * first runs `settle` exactly once, clearing the timer and dropping the entry.
   */
  const request = (method: string, params: unknown, signal?: AbortSignal): Promise<Any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      const cancel = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        pending.delete(id);
        cancel();
        fn();
      };

      pending.set(id, {
        resolve: (result) => settle(() => resolve(result)),
        reject: (err) => settle(() => reject(err)),
        cancel,
        method,
      });

      if (signal?.aborted) {
        settle(() => reject(new LspUnavailableError("disposed", method, `[pi-lens] ${method} aborted`)));
        return;
      }
      onAbort = () =>
        settle(() => reject(new LspUnavailableError("disposed", method, `[pi-lens] ${method} aborted`)));
      signal?.addEventListener("abort", onAbort, { once: true });

      timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new LspUnavailableError(
                "timeout",
                method,
                `[pi-lens] the language server did not respond to ${method} within ${requestTimeoutMs}ms`,
              ),
            ),
          ),
        requestTimeoutMs,
      );

      io.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  };
  const notify = (method: string, params: unknown): void => {
    io.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  };

  return {
    async initialize(rootUri, signal) {
      await request(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          capabilities: {
            textDocument: { publishDiagnostics: {}, hover: {}, references: {}, definition: {}, rename: {} },
          },
          workspaceFolders: null,
        },
        signal,
      );
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
    async hover(uri, pos, signal) {
      return extractHover(
        await request("textDocument/hover", { textDocument: { uri }, position: toLspPos(pos) }, signal),
      );
    },
    async references(uri, pos, signal) {
      return toLocations(
        await request(
          "textDocument/references",
          {
            textDocument: { uri },
            position: toLspPos(pos),
            context: { includeDeclaration: true },
          },
          signal,
        ),
      );
    },
    async definition(uri, pos, signal) {
      return toLocations(
        await request("textDocument/definition", { textDocument: { uri }, position: toLspPos(pos) }, signal),
      );
    },
    async rename(uri, pos, newName, signal) {
      return toRenameEdits(
        await request(
          "textDocument/rename",
          { textDocument: { uri }, position: toLspPos(pos), newName },
          signal,
        ),
      );
    },
    async shutdown() {
      await request("shutdown", null);
      notify("exit", null);
    },
    dispose(reason) {
      // Copy first: rejecting settles entries, which mutates the map as we iterate.
      for (const entry of [...pending.values()]) {
        entry.reject(new LspUnavailableError("disposed", entry.method, `[pi-lens] ${entry.method}: ${reason}`));
      }
      pending.clear();
    },
    pendingCount() {
      return pending.size;
    },
  };
}
