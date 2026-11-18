
import { writeLog } from './log';

export type RendererLogLevel = 'info' | 'warn' | 'error';

export interface RendererLogPayload {
  level: RendererLogLevel;
  message: string;
  detail?: unknown;
}

const MAX_MESSAGE_CHARS = 2_000;
const MAX_DETAIL_JSON_CHARS = 4_096;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_LINES = 120;

const SENSITIVE_KEY_RE = /api[_-]?key|authorization|token|secret|password|cookie|credential|email|phone|nickname|avatar/i;
const BASE64ISH_RE = /^[A-Za-z0-9+/=_-]{200,}$/;
const INLINE_KEY_VALUE_RE = /([?#&\s]|^)([\w-]+)=/g;
const INLINE_SECRET_KEY_RE = /token|api[_-]?key|password|secret|cookie|credential|authorization/i;
const INLINE_AUTH_SCHEME_RE = /(Bearer|Basic)\s+\S+/gi;

export function asRendererLogPayload(value: unknown): RendererLogPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as { level?: unknown; message?: unknown; detail?: unknown };
  if (candidate.level !== 'info' && candidate.level !== 'warn' && candidate.level !== 'error') {
    return null;
  }
  if (typeof candidate.message !== 'string' || candidate.message === '') return null;
  const payload: RendererLogPayload = { level: candidate.level, message: candidate.message };
  if (candidate.detail !== undefined) payload.detail = candidate.detail;
  return payload;
}

export function sanitizeRendererLogMessage(message: string): string {
  const schemes = message.replaceAll(
    INLINE_AUTH_SCHEME_RE,
    (_m, scheme: string) => `${scheme} [redacted]`,
  );
  const parts: string[] = [];
  let cursor = 0;
  INLINE_KEY_VALUE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_KEY_VALUE_RE.exec(schemes)) !== null) {
    if (!INLINE_SECRET_KEY_RE.test(match[2]!)) continue;
    const start = INLINE_KEY_VALUE_RE.lastIndex;
    let end = start;
    while (end < schemes.length && !/[\s&#]/.test(schemes[end]!)) end += 1;
    if (end === start) continue;
    parts.push(schemes.slice(cursor, start), '[redacted]');
    cursor = end;
    INLINE_KEY_VALUE_RE.lastIndex = end;
  }
  const redacted = parts.join('') + schemes.slice(cursor);
  const flattened = redacted.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  return flattened.length > MAX_MESSAGE_CHARS
    ? `${flattened.slice(0, MAX_MESSAGE_CHARS)}… [+${flattened.length - MAX_MESSAGE_CHARS} chars]`
    : flattened;
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'string') {
    const s = value as string;
    if (BASE64ISH_RE.test(s)) return `[base64-like, ${s.length} chars omitted]`;
    return sanitizeRendererLogMessage(s);
  }
  if (t !== 'object') return String(value as bigint | symbol | (() => unknown));
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: sanitizeRendererLogMessage(value.message),
    };
    if (value.stack !== undefined) out['stack'] = sanitizeRendererLogMessage(value.stack);
    if (value.cause !== undefined) out['cause'] = sanitizeDetailValue(value.cause, depth + 1);
    return out;
  }
  if (depth >= 6) return '[max depth]';
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((v) => sanitizeDetailValue(v, depth + 1));
    if (value.length > 50) out.push(`[+${value.length - 50} more items]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, 50)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : sanitizeDetailValue(v, depth + 1);
  }
  if (entries.length > 50) out['_truncatedKeys'] = entries.length - 50;
  return out;
}

export function serializeRendererLogDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(sanitizeDetailValue(detail, 0)) ?? 'undefined';
  } catch {
    return '[unserializable detail]';
  }
  return json.length > MAX_DETAIL_JSON_CHARS
    ? `${json.slice(0, MAX_DETAIL_JSON_CHARS)}… [truncated]`
    : json;
}

export type RendererLogWriter = (payload: unknown, source?: string) => void;

export function createRendererLogWriter(
  write: (level: RendererLogLevel, line: string, source?: string) => void = (level, line, source) =>
    writeLog(level, line, source),
  now: () => number = Date.now,
  prefix = 'renderer',
): RendererLogWriter {
  let windowStart = now();
  let written = 0;
  let dropped = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushDropped = (): void => {
    if (dropped === 0) return;
    write('warn', `[${prefix}] dropped ${dropped} log line(s) in the last minute (rate limit)`);
    dropped = 0;
  };

  const rollWindow = (): void => {
    if (now() - windowStart < RATE_LIMIT_WINDOW_MS) return;
    flushDropped();
    windowStart = now();
    written = 0;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  return (payload: unknown, source?: string): void => {
    const parsed = asRendererLogPayload(payload);
    if (parsed === null) return;
    rollWindow();
    if (written >= RATE_LIMIT_MAX_LINES) {
      dropped++;
      if (flushTimer === null) {
        flushTimer = setTimeout(
          () => {
            flushTimer = null;
            rollWindow();
          },
          RATE_LIMIT_WINDOW_MS - (now() - windowStart),
        );
        flushTimer.unref?.();
      }
      return;
    }
    written++;
    const detail = serializeRendererLogDetail(parsed.detail);
    const line = `[${prefix}] ${sanitizeRendererLogMessage(parsed.message)}`;
    write(parsed.level, detail === undefined ? line : `${line}  ${detail}`, source);
  };
}
