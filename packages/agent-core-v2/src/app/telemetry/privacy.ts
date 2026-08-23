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

const SEGMENT_CORE = String.raw`[\p{L}\p{M}\p{N}.$_~+-]+`;
const SEGMENT_ATOM = String.raw`${SEGMENT_CORE}(?:'${SEGMENT_CORE})*`;
const SEGMENT_DIR = String.raw`${SEGMENT_ATOM}(?: +${SEGMENT_ATOM})*`;
const FINAL_WITH_EXTENSION = String.raw`${SEGMENT_ATOM}(?: +${SEGMENT_ATOM})*?\.[\p{L}\p{M}\p{N}]{1,16}`;
const FINAL_SEGMENT = String.raw`(?:${FINAL_WITH_EXTENSION}|${SEGMENT_DIR})`;
const PATH_BOUNDARY = String.raw`(?![\p{L}\p{M}\p{N}.$_~+\\/-])`;
const WINDOWS_COMPONENT = String.raw`[^\\/:*?"<>|\u0000-\u001F]+`;
const WINDOWS_FINAL_WITH_EXTENSION = String.raw`${WINDOWS_COMPONENT}?\.[\p{L}\p{M}\p{N}]{1,16}`;
const WINDOWS_EXTENSION_TAIL = String.raw`(?:[\\/]${WINDOWS_COMPONENT})*[\\/]${WINDOWS_FINAL_WITH_EXTENSION}(?=$|[\s'"])`;
const WINDOWS_GENERIC_TAIL = String.raw`(?:[\\/]${WINDOWS_COMPONENT})+[\\/]?(?=$|['"])`;
const WINDOWS_TAIL = String.raw`(?:${WINDOWS_EXTENSION_TAIL}|${WINDOWS_GENERIC_TAIL})`;

const WINDOWS_LONG_BASE = String.raw`\\\\\?\\(?:UNC\\[^\s\\/]+\\${WINDOWS_COMPONENT}|[A-Za-z]:)`;
const WINDOWS_UNC_BASE = String.raw`\\\\[^\s\\/]+\\${WINDOWS_COMPONENT}`;
const WINDOWS_UNC_OR_LONG = String.raw`(?:${WINDOWS_LONG_BASE}|${WINDOWS_UNC_BASE})(?:${WINDOWS_TAIL}|[\\/]?)`;
const WINDOWS_DRIVE = String.raw`\b[A-Za-z]:${WINDOWS_TAIL}${PATH_BOUNDARY}`;
const POSIX_PATH = String.raw`(?:(?:\/${SEGMENT_DIR}){2,}\/|(?:\/${SEGMENT_DIR})+\/${FINAL_SEGMENT})${PATH_BOUNDARY}`;
const ABSOLUTE_PATH = new RegExp(`${WINDOWS_UNC_OR_LONG}|${WINDOWS_DRIVE}|${POSIX_PATH}`, 'gu');

function redactAbsolutePath(match: string): string {
  const normalized = match.replaceAll('\\', '/');
  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(match);
  const index = windowsPath
    ? normalized.toLowerCase().indexOf(NODE_MODULES_MARKER)
    : normalized.indexOf(NODE_MODULES_MARKER);
  return index === -1 ? REDACTED_PATH : normalized.slice(index);
}

export function cleanTelemetryString(value: string): string {
  if (value.length > 8192) return '<REDACTED: oversized telemetry-string>';
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
