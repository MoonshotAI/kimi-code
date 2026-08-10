import type { LogContext, LogEntry } from './types';

export const MSG_MAX_CHARS = 200;
export const CTX_VALUE_MAX_CHARS = 2048;
export const STACK_MAX_BYTES = 2048;
export const ENTRY_MAX_BYTES = 4096;
export const REDACT_MAX_DEPTH = 10;

const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'apikey',
  'token',
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'password',
  'secret',
  'clientsecret',
  'apisecret',
  'cookie',
  'setcookie',
  'bearer',
]);

const SAFE_KEY_RE = /^[\w.-]+$/;
const ELLIPSIS = '…';
const TRUNCATED_TAIL = ` …truncated`;
const REDACTED = '[REDACTED]';
const RAW_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi,
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`]+/gi,
  /\b(cookie\s*[:=]\s*)[^\r\n]+/gi,
];

const LEVEL_LABEL: Record<Exclude<LogEntry['level'], never>, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
};

const ANSI_LEVEL: Record<Exclude<LogEntry['level'], never>, string> = {
  error: '\u001B[31m',
  warn: '\u001B[33m',
  info: '\u001B[36m',
  debug: '\u001B[90m',
};
const ANSI_RESET = '\u001B[0m';

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[_\-.]/g, '');
}

export function redactCtx(ctx: LogContext): LogContext {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > REDACT_MAX_DEPTH) return '[REDACTED:depth]';
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[REDACTED:cycle]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(normalizeKey(key))
        ? REDACTED
        : walk(raw, depth + 1);
    }
    return out;
  };
  return walk(ctx, 0) as LogContext;
}

export interface FormatOptions {
  readonly ansi?: boolean | undefined;
  readonly omitContextKeys?: readonly string[];
}

export interface FormattedEntry {
  readonly text: string;
  readonly dropped: boolean;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + ELLIPSIS;
}

function serializeValue(raw: unknown): string {
  if (typeof raw === 'string') return redactString(raw);
  if (raw === undefined) return 'undefined';
  if (raw === null) return 'null';
  if (
    typeof raw === 'number' ||
    typeof raw === 'boolean' ||
    typeof raw === 'bigint' ||
    typeof raw === 'symbol'
  ) {
    return String(raw);
  }
  try {
    const json = JSON.stringify(raw);
    if (json !== undefined) return json;
  } catch {
    // fall through to a stable non-contentful fallback
  }
  if (typeof raw === 'function') return raw.name === '' ? '[Function]' : `[Function: ${raw.name}]`;
  return Object.prototype.toString.call(raw);
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of RAW_SECRET_PATTERNS) {
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  return out;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function formatPair(key: string, raw: unknown): string {
  const limited = truncate(serializeValue(raw), CTX_VALUE_MAX_CHARS);
  const renderedKey = SAFE_KEY_RE.test(key) ? key : quote(key);
  const renderedVal = /[\s="\\]/.test(limited) || limited.length === 0 ? quote(limited) : limited;
  return `${renderedKey}=${renderedVal}`;
}

function clipBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  // Binary-search the longest prefix that fits.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (
      Buffer.byteLength(text.slice(0, mid), 'utf-8') <=
      maxBytes - Buffer.byteLength(TRUNCATED_TAIL, 'utf-8')
    ) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + TRUNCATED_TAIL;
}

function clipStack(stack: string): string {
  if (Buffer.byteLength(stack, 'utf-8') <= STACK_MAX_BYTES) return stack;
  return clipBytes(stack, STACK_MAX_BYTES);
}

function indentStack(stack: string): string {
  return stack
    .split('\n')
    .map((line, i) => (i === 0 ? `  ${line}` : `    ${line.trimStart()}`))
    .join('\n');
}

export function formatEntry(entry: LogEntry, options: FormatOptions = {}): FormattedEntry {
  const ctx = entry.ctx ? redactCtx(entry.ctx) : undefined;
  const omitContextKeys = new Set(options.omitContextKeys ?? []);
  const msg = truncate(entry.msg, MSG_MAX_CHARS);
  const pairs: string[] = [];
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (omitContextKeys.has(k)) continue;
      if (v !== undefined) pairs.push(formatPair(k, v));
    }
  }

  const time = new Date(entry.t).toISOString();
  const label = LEVEL_LABEL[entry.level];
  const rendered = pairs.length === 0
    ? `${time} ${label} ${msg}`
    : `${time} ${label} ${msg}  ${pairs.join(' ')}`;

  let head = Buffer.byteLength(rendered, 'utf-8') > ENTRY_MAX_BYTES
    ? clipBytes(rendered, ENTRY_MAX_BYTES)
    : rendered;

  if (options.ansi === true) {
    head = `${ANSI_LEVEL[entry.level]}${head}${ANSI_RESET}`;
  }

  if (entry.error?.stack) {
    head = `${head}\n${indentStack(clipStack(redactString(entry.error.stack)))}`;
  } else if (entry.error?.message) {
    head = `${head}\n  Error: ${redactString(entry.error.message)}`;
  }

  return { text: head, dropped: false };
}

export function extractError(value: Error): { message: string; stack?: string } {
  return typeof value.stack === 'string'
    ? { message: value.message, stack: value.stack }
    : { message: value.message };
}
