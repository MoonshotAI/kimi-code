// Renderer → main log sink (`kimi:renderer-log`).
//
// The sandboxed renderer cannot write files, so its diagnostics would die in
// the devtools console of packaged builds. This module receives renderer log
// lines over IPC and appends them to the same file the main process writes
// (log.ts), prefixed `[renderer]` so both sources interleave on one timeline.
//
// Renderer input is untrusted: everything is validated, redacted, truncated
// and rate-limited here before it touches the disk, no matter what the
// preload already checked.

import { log } from './log';

export type RendererLogLevel = 'info' | 'warn' | 'error';

export interface RendererLogPayload {
  level: RendererLogLevel;
  message: string;
  detail?: unknown;
}

const MAX_MESSAGE_CHARS = 2_000;
const MAX_DETAIL_JSON_CHARS = 4_096;

// One renderer erroring in a tight loop must not burn through the 5MB log
// file: a sliding window caps forwarded lines, and a single summary line
// reports how many were dropped when the window ends.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_LINES = 120;

// Same sensitive-key policy as the renderer's debug/trace.ts sanitizer.
const SENSITIVE_KEY_RE = /api[_-]?key|authorization|token|secret|password|cookie|credential/i;
/** Long unbroken base64-ish runs (uploads, inlined images) are size, not signal. */
const BASE64ISH_RE = /^[A-Za-z0-9+/=_-]{200,}$/;
/** Credentials riding inside a message string (URL/basic-auth forms). Keys
    merely CONTAINING a sensitive name (client_secret, access_token, …) count,
    mirroring the object-key policy's substring match. */
const INLINE_KEY_SECRET_RE =
  /([?#&\s]|^)[\w-]*(token|api[_-]?key|password|secret|cookie|credential|authorization)[\w-]*=[^\s&#]+/gi;
/** Authorization schemes with their token. Applied BEFORE the key=value pass
    so `authorization=Bearer abc123` redacts both halves instead of leaving the
    token behind as `authorization=[redacted] abc123`. */
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
  const redacted = schemes.replaceAll(INLINE_KEY_SECRET_RE, (m) => {
    const eq = m.indexOf('=');
    return `${m.slice(0, eq + 1)}[redacted]`;
  });
  // Physical newlines would let one payload write multiple unprefixed log
  // lines — forge levels, break parsers, and bypass the per-line rate limit.
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
  // Error fields are non-enumerable — the generic object branch below would
  // serialize an Error as `{}` and lose the very reason being logged.
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

/** Sanitize + serialize a detail payload; undefined when there is none. */
export function serializeRendererLogDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  let json: string;
  try {
    // Sanitization itself can throw on hostile input (e.g. a throwing
    // getter) — the IPC handler must never propagate.
    json = JSON.stringify(sanitizeDetailValue(detail, 0)) ?? 'undefined';
  } catch {
    return '[unserializable detail]';
  }
  return json.length > MAX_DETAIL_JSON_CHARS
    ? `${json.slice(0, MAX_DETAIL_JSON_CHARS)}… [truncated]`
    : json;
}

export type RendererLogWriter = (payload: unknown) => void;

/**
 * Rate-limited writer behind the IPC handler. `write` defaults to the real
 * file logger; `now` is injectable so tests can drive the sliding window.
 */
export function createRendererLogWriter(
  write: (level: RendererLogLevel, line: string) => void = (level, line) => log[level](line),
  now: () => number = Date.now,
): RendererLogWriter {
  let windowStart = now();
  let written = 0;
  let dropped = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushDropped = (): void => {
    if (dropped === 0) return;
    write('warn', `[renderer] dropped ${dropped} log line(s) in the last minute (rate limit)`);
    dropped = 0;
  };

  const rollWindow = (): void => {
    if (now() - windowStart < RATE_LIMIT_WINDOW_MS) return;
    flushDropped();
    windowStart = now();
    written = 0;
    // The pending timer belongs to the window that just ended; clear it so
    // the next drop schedules a fresh one for the new window.
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  return (payload: unknown): void => {
    const parsed = asRendererLogPayload(payload);
    if (parsed === null) return;
    rollWindow();
    if (written >= RATE_LIMIT_MAX_LINES) {
      dropped++;
      // Flush on a timer so the summary lands even when no further payload
      // arrives (unref'd: it must never hold the process open — a real quit
      // still loses the count).
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
    const line = `[renderer] ${sanitizeRendererLogMessage(parsed.message)}`;
    write(parsed.level, detail === undefined ? line : `${line}  ${detail}`);
  };
}
