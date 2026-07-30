/**
 * `telemetry` domain (L1) — outbound PII cleaning for telemetry properties.
 *
 * Redacts user-identifying content from string property values before events
 * leave the process: URLs, emails, common token formats, and absolute file
 * paths become labeled `<REDACTED: ...>` placeholders, while `node_modules/`
 * path tails are kept because they carry diagnostic value without user data.
 * App-scoped, no collaborators.
 *
 * Path segments are matched by exclusion rather than with `\w`, which is
 * ASCII-only and so left the tail of any path under a `李明`, `иван` or `josé`
 * home directory in the payload. A segment may contain interior spaces
 * (`Program Files`, `alice chen`); the final segment may too, but only when it
 * ends in a file extension, so a path followed by prose is redacted without
 * swallowing the sentence. A POSIX path must not start right after an
 * alphanumeric, or chained fractions such as `read 1/2 then 3/4` would read as
 * one. Absolute paths match as a single alternation in one pass, because
 * running the branches separately let a later branch re-scan an earlier one's
 * replacement. The behaviour these rules produce is pinned case by case in
 * `test/app/telemetry/privacy.test.ts`.
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

const SEGMENT = String.raw`(?:[^\\/\s"<>|:*?]+)`;
const SEGMENT_WITH_SPACES = String.raw`(?:${SEGMENT}(?: +${SEGMENT})*)`;
const INTERIOR = String.raw`(?:${SEGMENT_WITH_SPACES}[\\/])`;
const FINAL_SEGMENT = String.raw`(?:${SEGMENT_WITH_SPACES}\.[A-Za-z][A-Za-z0-9]{0,9}(?![^\s"'<>])|${SEGMENT})`;

const ABSOLUTE_PATH = new RegExp(
  [
    String.raw`(?:\\\\[?.]\\)?[A-Za-z]:[\\/]${INTERIOR}*${FINAL_SEGMENT}?`,
    String.raw`\\\\${INTERIOR}+${FINAL_SEGMENT}?`,
    String.raw`(?<![A-Za-z0-9])(?:\/${SEGMENT_WITH_SPACES}(?=\/))+\/${FINAL_SEGMENT}\/?`,
  ].join('|'),
  'g',
);

function redactPath(match: string): string {
  const normalized = match.replaceAll('\\', '/');
  const index = normalized.indexOf(NODE_MODULES_MARKER);
  return index === -1 ? REDACTED_PATH : normalized.slice(index);
}

export function cleanTelemetryString(value: string): string {
  let out = value;
  for (const [pattern, label] of LABELED_PATTERNS) {
    out = out.replace(pattern, label);
  }
  return out.replace(ABSOLUTE_PATH, redactPath);
}

export function cleanTelemetryProperties<P extends Record<string, unknown>>(properties: P): P {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = typeof value === 'string' ? cleanTelemetryString(value) : value;
  }
  return out as P;
}
