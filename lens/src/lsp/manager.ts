import { whichOnPath } from "../../../shared/exec.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extname } from "node:path";
import { createLspClient, uriToPath, type LspClient } from "./client.ts";
import type { ServerSpec } from "./config.ts";
import { lspServers } from "../toolchains.ts";

import type { Diagnostic } from "../diagnostics.ts";

/** Max time to wait for a cold server's first project-load/publish before proceeding anyway. */
const WARM_TIMEOUT_MS = 6000;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Resolves when `signal` aborts; never resolves when there is none. */
const aborted = (signal?: AbortSignal): Promise<void> =>
  signal
    ? new Promise((r) => {
        if (signal.aborted) r();
        else signal.addEventListener("abort", () => r(), { once: true });
      })
    : new Promise(() => {});

export interface LspManager {
  /** Ensure the file's server is up and the file is opened; resolves the client (null if no server). */
  ready(path: string, cwd: string, signal?: AbortSignal): Promise<LspClient | null>;
  /** Open/refresh the file and wait (bounded) for the server to publish diagnostics for it. */
  pull(path: string, cwd: string, timeoutMs?: number): Promise<Diagnostic[]>;
  diagnosticsFor(path: string): Diagnostic[];
  shutdownAll(): Promise<void>;
}

interface Entry {
  client: LspClient;
  proc: ChildProcess;
  ready: Promise<void>;
  /** Resolves on the server's first publishDiagnostics — a reliable "project loaded" signal. */
  warm: Promise<void>;
  /**
   * Documents this **server instance** has been sent `didOpen` for.
   *
   * Per entry, not per manager. A single shared set was wrong twice over: a server that
   * died and was respawned (a crash, or `shutdownAll` on a fork) inherited the claim that
   * every previously-seen file was open, so `syncFile` sent the fresh process a
   * `didChange` for a document it had never been told about — which servers drop, so
   * diagnostics silently stopped for the rest of the session. The same held across two
   * servers keyed by different cwds.
   */
  opened: Set<string>;
}

/**
 * `cwd` is a per-call argument, not a construction parameter.
 *
 * pi-lens previously captured `process.cwd()` in its extension factory and passed it
 * here once, so the server's root — the child process's cwd and the `initialize`
 * rootUri — was fixed at extension-load time. Where Pi's session cwd differed, every
 * diagnostic and every query was rooted in the wrong project for the whole session,
 * unrecoverably. Clients are keyed by `(cwd, command)` so a different cwd yields a
 * correctly-rooted second server rather than a silently wrong first one.
 */
export function createManager(
  servers: Record<string, ServerSpec> = lspServers(),
  which: (bin: string) => boolean = whichOnPath,
): LspManager {
  const clients = new Map<string, Entry>();
  const diagnostics = new Map<string, Diagnostic[]>();
  const waiters = new Map<string, Array<(ds: Diagnostic[]) => void>>();

  function ensure(path: string, cwd: string): { entry: Entry; spec: ServerSpec } | null {
    const ext = extname(path).slice(1).toLowerCase();
    const spec = servers[ext];
    if (!spec) return null;
    // Fail fast on a missing binary — treat it as "no server", exactly like an unmapped
    // extension. Spawning a binary that isn't there yields a process that never answers
    // `initialize`, and the LSP request has no timeout, so awaiting it hangs the read/edit
    // hook forever. (This is what froze `.json`/`.go` reads: those servers are commonly absent.)
    if (!which(spec.command[0]!)) return null;
    // NUL-separated so no path or command can forge another pair's key.
    const cmdKey = `${cwd}\0${spec.command.join(" ")}`;
    let entry = clients.get(cmdKey);
    if (!entry) {
      let proc: ChildProcess;
      try {
        proc = spawn(spec.command[0]!, spec.command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        return null;
      }
      let markWarm: () => void = () => {};
      const warm = new Promise<void>((resolve) => {
        markWarm = resolve;
      });
      // Built before `onDead` so the handler can clear this server's diagnostics as it
      // drops the entry. See `Entry.opened`, and the deletion in `onDead` below.
      const opened = new Set<string>();
      // Declared before `onDead` so the handler cannot hit a temporal dead zone: `proc` can
      // emit "error" synchronously, and `client?.` on a not-yet-initialised const throws
      // rather than short-circuiting.
      let client: LspClient | undefined;
      // If the process dies (crash, or a binary that vanished after the which-check), unblock
      // every awaiter and drop the entry so the next call can retry — never leave a wait
      // hanging. `markWarm` alone was not enough: it settles the readiness race but leaves
      // in-flight requests pending forever, which is the hole `dispose` closes.
      const onDead = (): void => {
        markWarm();
        clients.delete(cmdKey);
        // The findings go with the server that made them. `pull` resolves from this map
        // when its wait times out, so a respawned server that has not published yet would
        // otherwise hand the agent the *dead* one's diagnostics as the current state of a
        // file it has edited since — reported as a real result, because `client` is
        // non-null and nothing downstream can tell the two apart. Same argument as keeping
        // `opened` per entry rather than per manager, which is what makes this possible.
        for (const path of opened) diagnostics.delete(path);
        client?.dispose("language server exited");
      };
      proc.on("error", onDead);
      proc.on("exit", onDead);
      client = createLspClient({
        write: (s) => {
          try {
            proc.stdin?.write(s);
          } catch {
            /* stdin closed (server died) — the write is lost; awaiters unblock via onDead */
          }
        },
        onData: (cb) => {
          // `setEncoding` rather than `d.toString()` per chunk. `framing.ts` is careful to
          // count Content-Length in *bytes*, but that care is undone one layer up if each
          // Buffer is decoded independently: a multi-byte character split across a chunk
          // boundary becomes two U+FFFD replacements, which re-encode to a different byte
          // length than the original. The frame then desyncs and every message after it is
          // lost. Node's StringDecoder holds the partial sequence until the rest arrives,
          // so `cb` only ever sees complete characters.
          proc.stdout?.setEncoding("utf8");
          proc.stdout?.on("data", (d: string) => cb(d));
        },
      });
      client.onDiagnostics((uri, ds) => {
        markWarm(); // first publish ≈ project loaded/analyzed (queries are accurate from here)
        const file = uriToPath(uri);
        diagnostics.set(file, ds);
        const ws = waiters.get(file);
        if (ws) {
          waiters.delete(file);
          for (const w of ws) w(ds);
        }
      });
      // Race init against `warm`: a healthy server settles this when `initialize` returns; a
      // dead one settles `warm` via onDead — so `ready()` can never block on init forever.
      const ready = Promise.race([client.initialize(pathToFileURL(cwd).toString()).catch(() => {}), warm]);
      entry = { client, proc, ready, warm, opened };
      clients.set(cmdKey, entry);
    }
    return { entry, spec };
  }

  function syncFile(entry: Entry, spec: ServerSpec, path: string): void {
    const uri = pathToFileURL(path).toString();
    try {
      const text = readFileSync(path, "utf8");
      if (entry.opened.has(path)) entry.client.didChange(uri, text);
      else {
        entry.client.didOpen(uri, text, spec.languageId);
        entry.opened.add(path);
      }
    } catch {
      /* file gone */
    }
  }

  async function ready(path: string, cwd: string, signal?: AbortSignal): Promise<LspClient | null> {
    const r = ensure(path, cwd);
    if (!r) return null;
    // ONE budget for the whole readiness sequence, not one per stage. Both waits race
    // against the same promise, so the worst case is WARM_TIMEOUT_MS rather than the sum.
    // Stacking them is a real hazard now that `initialize` is itself bounded: an alive
    // but silent server would otherwise cost the request deadline *plus* the warm
    // timeout — roughly 16s — on a hook that runs after every read and edit.
    const budget = delay(WARM_TIMEOUT_MS);
    const escape = aborted(signal);

    await Promise.race([r.entry.ready, budget, escape]); // didOpen should follow `initialized`
    syncFile(r.entry, r.spec, path);
    // Wait for the server to finish its initial project load before trusting results.
    // Its first publishDiagnostics is an accurate "loaded" signal — measured: cross-file
    // references become complete within ~0.1s of it. Bounded so a server that never
    // publishes still proceeds (degraded, as before) instead of hanging.
    await Promise.race([r.entry.warm, budget, escape]);
    return r.entry.client;
  }

  return {
    ready,
    diagnosticsFor(path) {
      return diagnostics.get(path) ?? [];
    },
    async pull(path, cwd, timeoutMs = 1500) {
      // A bounded-wait rejection means the server is unavailable, not that the file is
      // clean — but for diagnostics those are the same outcome, and the read/edit hook
      // must never break because a language server misbehaved.
      const client = await ready(path, cwd).catch(() => null);
      if (!client) return [];
      return new Promise((resolve) => {
        const arr = waiters.get(path) ?? [];
        waiters.set(path, arr);
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Deregister on *every* settling path, not just the publish one. Only the
        // publish handler used to clear `waiters`, so a file whose server never
        // publishes — the case the timeout exists for — left its callback in the array
        // and its timer armed, once per read or edit, for the life of the session.
        const finish = (ds: Diagnostic[]) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          const at = arr.indexOf(finish);
          if (at >= 0) arr.splice(at, 1);
          if (arr.length === 0) waiters.delete(path);
          resolve(ds);
        };
        arr.push(finish);
        timer = setTimeout(() => finish(diagnostics.get(path) ?? []), timeoutMs);
      });
    },
    async shutdownAll() {
      for (const { client, proc } of clients.values()) {
        try {
          await Promise.race([client.shutdown(), new Promise((r) => setTimeout(r, 500))]);
        } catch {
          /* ignore — a server that will not shut down cleanly still gets killed below */
        }
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        // The shutdown race abandons the request without settling it, leaving its
        // deadline timer armed. Unsettled timers keep the event loop alive, which would
        // stall Pi's exit by up to the request timeout. dispose clears them.
        client.dispose("shutting down");
      }
      clients.clear();
      // Nothing is left that could vouch for these. A fork restarts the servers cold, and
      // a cached finding surviving that would be attributed to the fresh one.
      diagnostics.clear();
    },
  };
}
