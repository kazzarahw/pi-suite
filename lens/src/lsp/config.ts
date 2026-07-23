export interface ServerSpec {
  command: string[];
  languageId: string;
}

/** Default LSP servers keyed by file extension. TS/JS ship first; others are config-only. */
export const DEFAULT_SERVERS: Record<string, ServerSpec> = {
  ts: { command: ["typescript-language-server", "--stdio"], languageId: "typescript" },
  tsx: { command: ["typescript-language-server", "--stdio"], languageId: "typescriptreact" },
  js: { command: ["typescript-language-server", "--stdio"], languageId: "javascript" },
  jsx: { command: ["typescript-language-server", "--stdio"], languageId: "javascriptreact" },
  mjs: { command: ["typescript-language-server", "--stdio"], languageId: "javascript" },
  cjs: { command: ["typescript-language-server", "--stdio"], languageId: "javascript" },
};
