/**
 * `telemetry` domain — outbound PII cleaning for telemetry properties.
 *
 * Redacts user-identifying content from string property values before events
 * leave the process: URLs, emails, common token formats, and absolute file
 * paths become labeled `<REDACTED: ...>` placeholders, while `node_modules/`
 * path tails are kept because they carry diagnostic value without user data.
 * App-scoped, no collaborators.
 *
 * Path matching is Unicode-aware (`\p{L}` / `\p{M}` / `\p{N}`) so non-ASCII home
 * directory names, apostrophes, UNC shares, `\\?\` long paths, and
 * drive-letter paths spelled with `/` are redacted the same way as the
 * ASCII `C:\…` / `/home/…` forms.
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

const SEGMENT_ATOM = String.raw`[\p{L}\p{M}\p{N}._'~+-]+`;
const SEGMENT_DIR = String.raw`${SEGMENT_ATOM}(?: ${SEGMENT_ATOM})*`;
const FINAL_WITH_EXTENSION = String.raw`${SEGMENT_ATOM}(?: ${SEGMENT_ATOM})*?\.[\p{L}\p{M}\p{N}]{1,16}`;
const FINAL_SEGMENT = String.raw`(?:${FINAL_WITH_EXTENSION}|${SEGMENT_ATOM})`;
const WINDOWS_TAIL = String.raw`(?:(?:[\\/]${SEGMENT_DIR})+[\\/]|(?:[\\/]${SEGMENT_DIR})*[\\/]${FINAL_SEGMENT})`;
const PATH_BOUNDARY = String.raw`(?![\p{L}\p{M}\p{N}._'~+\\/-])`;

const WINDOWS_UNC_OR_LONG = String.raw`(?:\\\\\?(?:\\(?:UNC\\[^\s\\/]+\\[^\s\\/]+|[A-Za-z]:))|\\\\[^\s\\/]+\\[^\s\\/]+)${WINDOWS_TAIL}${PATH_BOUNDARY}`;
const WINDOWS_DRIVE = String.raw`\b[A-Za-z]:${WINDOWS_TAIL}${PATH_BOUNDARY}`;
const POSIX_PATH = String.raw`(?:(?:\/${SEGMENT_DIR}){2,}\/|(?:\/${SEGMENT_DIR})+\/${FINAL_SEGMENT})${PATH_BOUNDARY}`;
const ABSOLUTE_PATH = new RegExp(`${WINDOWS_UNC_OR_LONG}|${WINDOWS_DRIVE}|${POSIX_PATH}`, 'gu');

function redactAbsolutePath(match: string): string {
  const normalized = match.replaceAll('\\', '/');
  const index = normalized.toLowerCase().indexOf(NODE_MODULES_MARKER);
  return index === -1 ? REDACTED_PATH : normalized.slice(index);
}

export function cleanTelemetryString(value: string): string {
  let out = value;
  for (const [pattern, label] of LABELED_PATTERNS) {
    out = out.replace(pattern, label);
  }
  out = out.replace(ABSOLUTE_PATH, redactAbsolutePath);
  return out;
}

export function cleanTelemetryProperties<P extends Record<string, unknown>>(properties: P): P {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = typeof value === 'string' ? cleanTelemetryString(value) : value;
  }
  return out as P;
}
