const REDACTED = '[REDACTED]';

const RAW_SECRET_PATTERNS: readonly RegExp[] = [
  // Bearer tokens in Authorization headers
  /\b(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi,
  // Key-value pairs for api keys, tokens, secrets, passwords
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`]+/gi,
  // Cookie values
  /\b(cookie\s*[:=]\s*)[^\r\n]+/gi,
];

/**
 * Redact tokens, keys, and secrets from a string that may contain
 * upstream error messages. Best-effort — only catches common
 * key=value and header patterns.
 */
export function redactString(value: string): string {
  let out = value;
  for (const pattern of RAW_SECRET_PATTERNS) {
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  return out;
}
