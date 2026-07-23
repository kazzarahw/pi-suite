export interface SecretFinding {
  kind: string;
  match: string;
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { kind: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { kind: "github-token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { kind: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
];

/** Scan text for obvious secrets. Returns findings with the match truncated (never echo the full secret). */
export function scanSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) found.push({ kind, match: `${m[0].slice(0, 10)}…` });
  }
  return found;
}
