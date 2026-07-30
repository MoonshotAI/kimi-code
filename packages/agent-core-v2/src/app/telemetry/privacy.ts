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

/**
 * One path segment, defined by exclusion: anything that is not a separator,
 * whitespace, or a character no filesystem allows in a name.
 *
 * Deliberately not `\w`, which is ASCII-only — a home directory named `李明`,
 * `иван`, or `josé` ends the match at the first non-ASCII byte and the rest of
 * the path survives into the payload. Excluding rather than enumerating also
 * covers names containing an apostrophe, e.g. `O'Brien`.
 *
 * Each fragment below is a self-contained group so that appending a quantifier
 * to it applies to the whole fragment — bare `[^…]+` followed by `?` would read
 * as a lazy `+?` instead of an optional segment.
 */
const SEGMENT = String.raw`(?:[^\\/\s"<>|:*?]+)`;

/**
 * A segment that may contain interior spaces — `Program Files`, `alice chen`.
 *
 * Only used where the segment is followed by a separator, which is what keeps it
 * from running into surrounding prose: in `C:\proj\file.txt failed to open`
 * there is no separator after `open`, so the match ends at `file.txt`. A final
 * segment therefore uses `SEGMENT`, which stops at the first space.
 */
const SEGMENT_WITH_SPACES = String.raw`(?:${SEGMENT}(?: +${SEGMENT})*)`;

/** Zero or more interior segments, each consumed together with its separator. */
const INTERIOR = String.raw`(?:${SEGMENT_WITH_SPACES}[\\/])`;

/**
 * Absolute file paths, as one alternation so a single pass consumes each whole
 * path. Running the branches as separate passes let a later one re-scan an
 * earlier one's replacement, which produced `node_modules<REDACTED: ...>`.
 */
const ABSOLUTE_PATH = new RegExp(
  [
    // Drive-letter, either separator, optional `\\?\` / `\\.\` long-path prefix:
    // C:\a\b, C:/a/b, \\?\C:\a\b
    String.raw`(?:\\\\[?.]\\)?[A-Za-z]:[\\/]${INTERIOR}*${SEGMENT}?`,
    // UNC: \\server\share\...
    String.raw`\\\\${INTERIOR}+${SEGMENT}?`,
    // POSIX; the leading group is required, so a lone `/tmp` and the `/4` in
    // `3/4` are left alone
    String.raw`(?:\/${SEGMENT_WITH_SPACES}(?=\/))+\/${SEGMENT}\/?`,
  ].join('|'),
  'g',
);

function redactPath(match: string): string {
  // Normalize separators so the `node_modules/` marker is found on Windows too.
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
