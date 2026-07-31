/**
 * A fake `ExtensionAPI` for testing extension **wiring** — the `index.ts` layer.
 *
 * Every extension's `index.ts` is where hooks are subscribed, guards are applied
 * (`ctx.hasUI`, `mode === "off"`), and cwd is resolved. None of that had test
 * coverage in any of the seven original repos, which is why several defects lived
 * there undetected. This harness lets a test load an `index.ts`, invoke it, and
 * then drive its hooks directly.
 *
 * It is deliberately structural, not a Pi emulator: it records what was registered
 * and lets a test fire a hook with a chosen event and context.
 */

export interface FakeTool {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
}

export interface FakeCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => unknown;
}

export type HookHandler = (event: unknown, ctx: unknown) => unknown;

export interface FakeApi {
  tools: Map<string, FakeTool>;
  commands: Map<string, FakeCommand>;
  hooks: Map<string, HookHandler[]>;
  /** Handlers registered via `pi.events.on` (the cross-extension bus). */
  busHandlers: Map<string, Array<(data: unknown) => void>>;
  /** Everything emitted via `pi.events.emit`. */
  emitted: Array<{ event: string; data: unknown }>;
  /** Everything queued via `pi.sendMessage`. */
  messages: Array<{ message: unknown; options?: unknown }>;
  /**
   * Everything injected via `pi.sendUserMessage` — a message arriving *as the user*.
   *
   * Distinct from `messages` because the two are different acts. `sendMessage` queues harness
   * output the model reads as context; this speaks in the user's own voice and always triggers a
   * turn. pi-telegram's whole inbound half is this call, and there was nowhere to assert it.
   */
  userMessages: Array<{ content: unknown; options?: unknown }>;
  /** Everything persisted via `pi.appendEntry`. */
  entries: Array<{ customType: string; data?: unknown }>;
  /** Every `pi.setLabel` call, in order. `undefined` clears a label. */
  labels: Array<{ entryId: string; label: string | undefined }>;
  /** Widgets/status set via `ctx.ui` are recorded on the ctx, not here. */
  registerTool(tool: FakeTool): void;
  registerCommand(name: string, options: FakeCommand): void;
  on(hook: string, handler: HookHandler): void;
  events: {
    emit(event: string, data: unknown): void;
    on(event: string, handler: (data: unknown) => void): void;
  };
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(content: unknown, options?: unknown): void;
  appendEntry(customType: string, data?: unknown): void;
  setLabel(entryId: string, label: string | undefined): void;

  // --- test drivers ---
  /** Invoke every handler for `hook` in registration order; returns the last defined result. */
  fire(hook: string, event?: unknown, ctx?: unknown): Promise<unknown>;
  /** Deliver an event to `pi.events.on` subscribers, as a peer extension would. */
  emitBus(event: string, data: unknown): void;
  /** Whether any handler is registered for `hook`. */
  subscribes(hook: string): boolean;
}

export function createFakeApi(): FakeApi {
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, FakeCommand>();
  const hooks = new Map<string, HookHandler[]>();
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const messages: Array<{ message: unknown; options?: unknown }> = [];
  const userMessages: Array<{ content: unknown; options?: unknown }> = [];
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const labels: FakeApi["labels"] = [];

  const api: FakeApi = {
    tools,
    commands,
    hooks,
    busHandlers,
    emitted,
    messages,
    userMessages,
    entries,
    labels,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(hook, handler) {
      const list = hooks.get(hook) ?? [];
      list.push(handler);
      hooks.set(hook, list);
    },
    events: {
      emit(event, data) {
        emitted.push({ event, data });
      },
      on(event, handler) {
        const list = busHandlers.get(event) ?? [];
        list.push(handler);
        busHandlers.set(event, list);
      },
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    sendUserMessage(content, options) {
      userMessages.push({ content, options });
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    setLabel(entryId, label) {
      labels.push({ entryId, label });
    },
    async fire(hook, event, ctx) {
      let last: unknown;
      for (const handler of hooks.get(hook) ?? []) {
        const result = await handler(event ?? {}, ctx ?? fakeCtx());
        if (result !== undefined) last = result;
      }
      return last;
    },
    emitBus(event, data) {
      for (const handler of busHandlers.get(event) ?? []) handler(data);
    },
    subscribes(hook) {
      return (hooks.get(hook)?.length ?? 0) > 0;
    },
  };
  return api;
}

export interface FakeUiCalls {
  status: Array<{ id: string; text?: string }>;
  widgets: Array<{ id: string; lines?: string[] }>;
  notices: Array<{ msg: string; level?: string }>;
  customOpened: number;
}

export interface FakeCtx {
  hasUI: boolean;
  /** Pi's project-trust decision. Extensions must consult this before running
   *  anything the repository itself supplied. */
  isProjectTrusted(): boolean;
  mode: "tui" | "print" | "json" | "rpc";
  cwd: string;
  signal?: AbortSignal;
  sessionManager: {
    getCwd(): string;
    /** Pi keys per-session state on this; pi-git's checkpoint store is scoped by it. */
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(): unknown[];
    getLeafEntry(): unknown;
    /** Entry lookup for ancestor walks (pi-git resolves a restore target this way). */
    getEntry(id: string): unknown;
  };
  ui: {
    setStatus(id: string, text?: string): void;
    setWidget(id: string, lines?: string[]): void;
    notify(msg: string, level?: string): void;
    custom(render: unknown): Promise<unknown>;
  };
  /** Everything the extension pushed into `ctx.ui`, for assertions. */
  uiCalls: FakeUiCalls;
}

export interface FakeCtxOverrides {
  hasUI?: boolean;
  /** Defaults to true so existing tests keep their behaviour. */
  isProjectTrusted?: boolean;
  mode?: FakeCtx["mode"];
  cwd?: string;
  signal?: AbortSignal;
  branch?: unknown[];
  leafEntry?: unknown;
  sessionId?: string;
  /** Defaults to the leaf entry's own id. */
  leafId?: string | null;
  /** The session tree, by id, for `getEntry`. Entries carry `parentId`. */
  entries?: Record<string, unknown>;
}

/** A default interactive TUI context; override per test to exercise guards. */
export function fakeCtx(overrides: FakeCtxOverrides = {}): FakeCtx {
  const cwd = overrides.cwd ?? process.cwd();
  const uiCalls: FakeUiCalls = { status: [], widgets: [], notices: [], customOpened: 0 };
  return {
    hasUI: overrides.hasUI ?? true,
    isProjectTrusted: () => overrides.isProjectTrusted ?? true,
    mode: overrides.mode ?? "tui",
    cwd,
    signal: overrides.signal,
    sessionManager: {
      getCwd: () => cwd,
      getSessionId: () => overrides.sessionId ?? "test-session",
      getLeafId: () =>
        overrides.leafId ?? (overrides.leafEntry as { id?: string } | undefined)?.id ?? null,
      getBranch: () => overrides.branch ?? [],
      getLeafEntry: () => overrides.leafEntry,
      getEntry: (id: string) => overrides.entries?.[id],
    },
    ui: {
      setStatus: (id, text) => uiCalls.status.push({ id, text }),
      setWidget: (id, lines) => uiCalls.widgets.push({ id, lines }),
      notify: (msg, level) => uiCalls.notices.push({ msg, level }),
      custom: async () => {
        uiCalls.customOpened += 1;
        return undefined;
      },
    },
    uiCalls,
  };
}

/**
 * Load an extension's `index.ts` and invoke its default export against a fresh
 * fake API. Returns the api so tests can inspect registrations and fire hooks.
 */
export async function loadExtension(dir: string): Promise<FakeApi> {
  const api = createFakeApi();
  const mod = (await import(`../../${dir}/index.ts`)) as { default: (pi: unknown) => void };
  mod.default(api);
  return api;
}

/**
 * Reject if `p` has not settled within `ms` — the hang detector for bounded paths.
 *
 * Every test of a timeout, an abort, or a dead subprocess must go through this. A
 * hang test written without it does not fail; it stops the whole run, which reads
 * as a stuck CI job rather than a red test.
 *
 * The timer is cleared on settle. Without that, a suite of these leaves pending
 * timers behind and the test process lingers after the last assertion.
 */
export function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([p, bound]).finally(() => clearTimeout(timer)) as Promise<T>;
}
