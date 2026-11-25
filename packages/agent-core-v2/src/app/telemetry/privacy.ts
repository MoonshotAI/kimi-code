const REDACTED_PATH = '<REDACTED: user-file-path>';

const LABELED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<REDACTED: Email>'],
  [/https?:\/\/[^\s"'<>]+/gi, '<REDACTED: URL>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '<REDACTED: JWT>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<REDACTED: GitHub Token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<REDACTED: GitHub Token>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<REDACTED: Slack Token>'],
  [/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/g, '<REDACTED: API Key>'],
];

const MAX_TELEMETRY_LINE_LENGTH = 8192;
const MAX_TELEMETRY_VALUE_LENGTH = 32_768;
const OVERSIZED_LINE = '<REDACTED: oversized telemetry-line>';
const FILE_EXTENSION = String.raw`\.[\p{L}\p{M}\p{N}_+#~@$%=-]+`;

const PATH_BOUNDARY = String.raw`(?![\p{L}\p{M}\p{N}.$_~+\\/-])`;
const EXTENSION_BOUNDARY = String.raw`(?=$|[\s'",;:!?) }\u0060\]&|]|\.(?=\s|$))`;
const WINDOWS_EXTENSION_BOUNDARY = String.raw`${EXTENSION_BOUNDARY}(?!\s[^\\/:*?"<>|\u0060]*[\\/])`;
const WINDOWS_NEXT_DRIVE = String.raw`(?:[,;]\s(?=[^\\/:*?"<>|\u0060]*[A-Za-z]:[\\/])|(?:[,;\])}]|&&?|\|\|?)(?=[\[(]*(?:[\w.-]+=)?(?:[A-Za-z]:[\\/]|\/|[\\/]{2}))|\s(?=[^\s\\/:*?"<>|\u0060]*(?:[A-Za-z]:[\\/]|[\w.-]+=(?:\/|[\\/]{2}))))`;
const WINDOWS_DIAGNOSTIC_DELIMITER = String.raw`[,;]\s(?![^\\/:*?"<>|\u0060]*[\\/])`;
const WINDOWS_CLOSING_QUOTE = String.raw`'\s(?![^\\/:*?"<>|\u0060]*[\\/])`;
const WINDOWS_CLOSING_BRACKET = String.raw`[\])}](?![\p{L}\p{M}\p{N}.$_~+\\/-])`;
const WINDOWS_SEGMENT_END = String.raw`(?:${WINDOWS_NEXT_DRIVE}|${WINDOWS_DIAGNOSTIC_DELIMITER}|${WINDOWS_CLOSING_QUOTE}|${WINDOWS_CLOSING_BRACKET})`;
const WINDOWS_ATOM = String.raw`(?:(?!${WINDOWS_SEGMENT_END})[^\\/:*?'"<>|\u0000-\u001F\u0060])+`;
const WINDOWS_COMPONENT = String.raw`(?:(?!${WINDOWS_SEGMENT_END})[^\\/:*?"<>|\u0000-\u001F\u0060])+`;
const WINDOWS_FINAL_COMPONENT = String.raw`(?:(?!${WINDOWS_SEGMENT_END}|${FILE_EXTENSION}${WINDOWS_EXTENSION_BOUNDARY})[^\\/:*?"<>|\u0000-\u001F\u0060])+`;
const WINDOWS_QUOTED_COMPONENT = String.raw`${WINDOWS_ATOM}(?:(?:''|'(?=[^\s\\/]))${WINDOWS_ATOM})*`;
const WINDOWS_FINAL_ATOM = String.raw`(?:(?!${WINDOWS_SEGMENT_END}|${FILE_EXTENSION}${WINDOWS_EXTENSION_BOUNDARY})[^\\/:*?'"<>|\u0000-\u001F\u0060])+`;
const WINDOWS_QUOTED_FINAL_COMPONENT = String.raw`${WINDOWS_FINAL_ATOM}(?:(?:''|'(?=[^\s\\/]))${WINDOWS_FINAL_ATOM})*`;
const WINDOWS_FINAL_WITH_EXTENSION = String.raw`(?:${WINDOWS_FINAL_COMPONENT})?${FILE_EXTENSION}`;
const WINDOWS_EXTENSION_TAIL = String.raw`(?:[\\/]+${WINDOWS_COMPONENT})*[\\/]+${WINDOWS_FINAL_WITH_EXTENSION}${WINDOWS_EXTENSION_BOUNDARY}`;
const WINDOWS_GENERIC_TAIL = String.raw`(?:[\\/]+${WINDOWS_COMPONENT})+[\\/]*(?=$|[':*?"<>|\u0000-\u001F\u0060]|${WINDOWS_SEGMENT_END})`;
const WINDOWS_TAIL = String.raw`(?:${WINDOWS_EXTENSION_TAIL}|${WINDOWS_GENERIC_TAIL})`;

const WINDOWS_LONG_BASE = String.raw`[\\/]{2}\?[\\/](?:UNC[\\/][^\s\\/]+\\${WINDOWS_COMPONENT}|[A-Za-z]:)`;
const WINDOWS_UNC_BASE = String.raw`[\\/]{2}[^\s\\/]+[\\/]+${WINDOWS_COMPONENT}`;
const WINDOWS_UNC_OR_LONG = String.raw`(?:${WINDOWS_LONG_BASE}|${WINDOWS_UNC_BASE})(?:${WINDOWS_TAIL}|[\\/]?)`;
const WINDOWS_DEVICE_DRIVE = String.raw`[\\/]{2}\.[\\/][A-Za-z]:${WINDOWS_TAIL}${PATH_BOUNDARY}`;
const WINDOWS_DRIVE = String.raw`\b[A-Za-z]:${WINDOWS_TAIL}${PATH_BOUNDARY}`;
const POSIX_LIST_SPLIT = String.raw`(?:(?:[,:;]|&&?|\|\|?)(?=(?:[\w.-]+=)?\/)|\s(?=[\w.-]+=\/)|(?:&&|\|\|)(?![^\s/]*\/)|[\])}](?![\p{L}\p{M}\p{N}.$_~+\\/-]))`;
const POSIX_ATOM = String.raw`(?:(?![,:] | \/|${POSIX_LIST_SPLIT})[^/'"\u0000-\u001F\u0060])+`;
const POSIX_FINAL_ATOM = String.raw`(?:(?![,:] | \/|${POSIX_LIST_SPLIT}|${FILE_EXTENSION}${EXTENSION_BOUNDARY})[^/'"\u0000-\u001F\u0060])+`;
const POSIX_COMPONENT = String.raw`${POSIX_ATOM}(?:'(?=[^\s/])${POSIX_ATOM})*`;
const POSIX_FINAL_COMPONENT = String.raw`${POSIX_FINAL_ATOM}(?:'(?=[^\s/])${POSIX_FINAL_ATOM})*`;
const POSIX_FINAL_WITH_EXTENSION = String.raw`(?:${POSIX_FINAL_COMPONENT})?${FILE_EXTENSION}`;
const POSIX_EXTENSION_PATH = String.raw`(?:\/+${POSIX_COMPONENT})+\/+${POSIX_FINAL_WITH_EXTENSION}${EXTENSION_BOUNDARY}`;
const POSIX_GENERIC_ATOM = String.raw`(?:(?![,:] |${POSIX_LIST_SPLIT})[^/\s'"\u0000-\u001F\u0060])+`;
const POSIX_GENERIC_COMPONENT = String.raw`${POSIX_GENERIC_ATOM}(?:'(?=[^\s/])${POSIX_GENERIC_ATOM})*`;
const POSIX_SPACED_NAME = String.raw`(?:[ \t]+(?=[\p{Lu}\p{Lt}])${POSIX_GENERIC_COMPONENT})*`;
const POSIX_GENERIC_PATH = String.raw`\/+${POSIX_GENERIC_COMPONENT}(?:[ \t]*\/+${POSIX_GENERIC_COMPONENT})+${POSIX_SPACED_NAME}\/*(?=$|[\s'"\u0000-\u001F\u0060]|[,;:] |${POSIX_LIST_SPLIT})`;
const POSIX_PATH = String.raw`(?<![\p{L}\p{M}\p{N}.$_~+\\/-])(?:${POSIX_EXTENSION_PATH}|${POSIX_GENERIC_PATH})`;
const WINDOWS_PATH = `${WINDOWS_DEVICE_DRIVE}|${WINDOWS_UNC_OR_LONG}|${WINDOWS_DRIVE}`;
const WINDOWS_QUOTED_PATH = `'(?:${WINDOWS_PATH.replaceAll(WINDOWS_FINAL_COMPONENT, WINDOWS_QUOTED_FINAL_COMPONENT).replaceAll(WINDOWS_COMPONENT, WINDOWS_QUOTED_COMPONENT)})'`;
// Inside double quotes, spaces and diagnostic punctuation belong to the filename.
const WINDOWS_DOUBLE_QUOTED_PATH = String.raw`"(?:[A-Za-z]:[\\/]|[\\/]{2})[^"\u0000-\u001F]+"`;
const ABSOLUTE_PATH = new RegExp(`(${WINDOWS_DOUBLE_QUOTED_PATH}|${WINDOWS_QUOTED_PATH}|${WINDOWS_PATH})|${POSIX_PATH}`, 'gu');

function redactAbsolutePath(match: string, windowsPath: boolean): string {
  const quote = match[0];
  if (quote === "'" || quote === '"') {
    return quote + redactAbsolutePath(match.slice(1, -1), windowsPath) + quote;
  }
  const normalized = windowsPath ? match.replaceAll('\\', '/') : match;
  if (/\s\//u.test(normalized)) return REDACTED_PATH;
  const markerMatch = windowsPath
    ? /\/node_modules\//i.exec(normalized)
    : /\/node_modules\//.exec(normalized);
  if (markerMatch === null) return REDACTED_PATH;
  const tail = normalized.slice(markerMatch.index + 1);
  return /[A-Za-z]:[\\/]/.test(tail) || /(?:^|\s|=)(?:\/|[\\/]{2})/.test(tail) || tail.split(/[\\/]/).includes('..')
    ? REDACTED_PATH
    : tail;
}

function cleanTelemetryLine(line: string): string {
  if (line.length > MAX_TELEMETRY_LINE_LENGTH) return OVERSIZED_LINE;
  let out = line;
  for (const [pattern, label] of LABELED_PATTERNS) {
    out = out.replace(pattern, label);
  }
  return out.replace(ABSOLUTE_PATH, (match: string, windowsMatch: string | undefined) =>
    redactAbsolutePath(match, windowsMatch !== undefined && /^['"]?(?:[A-Za-z]:|\\|[\\/]{2}[^\\/]*\\)/.test(match)),
  );
}

export function cleanTelemetryString(value: string): string {
  let budget = MAX_TELEMETRY_VALUE_LENGTH;
  // One extra code unit distinguishes an exact fit from a truncated line or CRLF.
  const parts = value.slice(0, MAX_TELEMETRY_VALUE_LENGTH + 1).split(/(\r\n|[\n\r\u2028\u2029])/);
  let out = '';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    budget -= part.length;
    if (budget < 0) return out + OVERSIZED_LINE;
    out += index % 2 === 1 ? part : cleanTelemetryLine(part);
  }
  return out;
}

export function cleanTelemetryProperties<P extends Record<string, unknown>>(properties: P): P {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = typeof value === 'string' ? cleanTelemetryString(value) : value;
  }
  return out as P;
}
