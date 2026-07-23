import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extname } from "node:path";
import { createLspClient, uriToPath, type LspClient } from "./client.ts";
import { DEFAULT_SERVERS, type ServerSpec } from "./config.ts";
import type { Diagnostic } from "../diagnostics.ts";

export interface LspManager {
  /** Ensure the file's server is up and the file is opened; resolves the client (null if no server). */
  ready(path: string): Promise<LspClient | null>;
  /** Open/refresh the file and wait (bounded) for the server to publish diagnostics for it. */
  pull(path: string, timeoutMs?: number): Promise<Diagnostic[]>;
  diagnosticsFor(path: string): Diagnostic[];
  shutdownAll(): Promise<void>;
}

interface Entry {
  client: LspClient;
  proc: ChildProcess;
  ready: Promise<void>;
}

export function createManager(cwd: string, servers: Record<string, ServerSpec> = DEFAULT_SERVERS): LspManager {
  const clients = new Map<string, Entry>();
  const diagnostics = new Map<string, Diagnostic[]>();
  const opened = new Set<string>();
  const waiters = new Map<string, Array<(ds: Diagnostic[]) => void>>();

  function ensure(path: string): { entry: Entry; spec: ServerSpec } | null {
    const ext = extname(path).slice(1).toLowerCase();
    const spec = servers[ext];
    if (!spec) return null;
    const cmdKey = spec.command.join(" ");
    let entry = clients.get(cmdKey);
    if (!entry) {
      let proc: ChildProcess;
      try {
        proc = spawn(spec.command[0]!, spec.command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        return null;
      }
      proc.on("error", () => {
        /* missing binary etc. — degrade to no diagnostics */
      });
      const client = createLspClient({
        write: (s) => {
          proc.stdin?.write(s);
        },
        onData: (cb) => {
          proc.stdout?.on("data", (d) => cb(d.toString()));
        },
      });
      client.onDiagnostics((uri, ds) => {
        const file = uriToPath(uri);
        diagnostics.set(file, ds);
        const ws = waiters.get(file);
        if (ws) {
          waiters.delete(file);
          for (const w of ws) w(ds);
        }
      });
      const ready = client.initialize(pathToFileURL(cwd).toString()).catch(() => {});
      entry = { client, proc, ready };
      clients.set(cmdKey, entry);
    }
    return { entry, spec };
  }

  function syncFile(entry: Entry, spec: ServerSpec, path: string): void {
    const uri = pathToFileURL(path).toString();
    try {
      const text = readFileSync(path, "utf8");
      if (opened.has(path)) entry.client.didChange(uri, text);
      else {
        entry.client.didOpen(uri, text, spec.languageId);
        opened.add(path);
      }
    } catch {
      /* file gone */
    }
  }

  async function ready(path: string): Promise<LspClient | null> {
    const r = ensure(path);
    if (!r) return null;
    await r.entry.ready; // didOpen must follow `initialized`
    syncFile(r.entry, r.spec, path);
    return r.entry.client;
  }

  return {
    ready,
    diagnosticsFor(path) {
      return diagnostics.get(path) ?? [];
    },
    async pull(path, timeoutMs = 1500) {
      const client = await ready(path);
      if (!client) return [];
      return new Promise((resolve) => {
        const arr = waiters.get(path) ?? [];
        waiters.set(path, arr);
        let done = false;
        const finish = (ds: Diagnostic[]) => {
          if (!done) {
            done = true;
            resolve(ds);
          }
        };
        arr.push(finish);
        setTimeout(() => finish(diagnostics.get(path) ?? []), timeoutMs);
      });
    },
    async shutdownAll() {
      for (const { client, proc } of clients.values()) {
        try {
          await Promise.race([client.shutdown(), new Promise((r) => setTimeout(r, 500))]);
        } catch {
          /* ignore */
        }
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
    },
  };
}
