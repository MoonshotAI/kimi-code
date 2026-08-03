/**
 * `telemetry` domain (L1) — outbound PII cleaning for telemetry properties.
 *
 * Redacts user-identifying content from string property values before events
 * leave the process: URLs, emails, common token formats, and absolute file
 * paths become labeled `<REDACTED: ...>` placeholders, while `node_modules/`
 * path tails are kept because they carry diagnostic value without user data.
 * App-scoped, no collaborators.
 */

const REDACTED_PATH = '<REDACTED: user-file-path>';
const NODE_MODULES_MARKER = 'node_modules/';

const LABELED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<REDACTED: Email>'],
  [/https?:\/\/[^\s"'<>]+/gi, '<REDACTED: URL>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '<REDACTED: JWT>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<REDACTED: GitHub Token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<REDACTED: GitHub Token>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<REDACTED: Slack Token>'],
  [/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/g, '<REDACTED: API Key>'],
];

const POSIX_PATH = /(?:\/[\w.~+-]+){2,}\/?/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[\w.~ -]+\\?){2,}/g;

export function cleanTelemetryString(value: string): string {
  let out = value;
  for (const [pattern, label] of LABELED_PATTERNS) {
    out = out.replace(pattern, label);
  }
  out = out.replace(WINDOWS_PATH, REDACTED_PATH);
  out = out.replace(POSIX_PATH, (match) => {
    const index = match.indexOf(NODE_MODULES_MARKER);
    return index === -1 ? REDACTED_PATH : match.slice(index);
  });
  return out;
}

export function cleanTelemetryProperties<P extends Record<string, unknown>>(properties: P): P {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = typeof value === 'string' ? cleanTelemetryString(value) : value;
  }
  return out as P;
}
