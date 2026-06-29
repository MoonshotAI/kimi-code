// apps/kimi-web/src/debug/trace.ts
// KAP/daemon debug trace — a side-channel recording of REST calls and WS
// frames, kept in a bounded ring buffer for the opt-in debug panel.
//
// Opt-in: `?debug=1` in the URL or `localStorage["kimi-web.debug"]="1"`.
// When not enabled every record call is a single boolean check, and nothing
// is stored — normal use pays (almost) nothing. Recording NEVER changes the
// request/WS behavior: callers pass data in, errors here must not propagate.

import { ref, shallowRef } from 'vue';
import { safeGetString, STORAGE_KEYS } from '../lib/storage';

export type TraceSource = 'rest' | 'ws' | 'client';

export interface TraceEntry {
  id: number;
  /** Epoch ms when recorded. */
  ts: number;
  source: TraceSource;
  /**
   * rest:request | rest:response | rest:error
   * ws:lifecycle (connect/open/close/error/reconnect) | ws:in | ws:out
   */
  kind: string;
  /** One-line summary for the timeline. */
  label: string;
  sessionId?: string;
  /** REST method + path (for filtering/aggregation). */
  method?: string;
  path?: string;
  /** WS frame type (server_hello, ping, event.* / raw agent type, …). */
  eventType?: string;
  seq?: number;
  offset?: number;
  /** HTTP status (REST). */
  status?: number;
  /** Envelope code (REST) — 0 is success. */
  code?: number;
  requestId?: string;
  durationMs?: number;
  /** Sanitized + truncated payload for the detail view. */
  detail?: unknown;
}

const MAX_ENTRIES = 1000;
/** A single entry's detail JSON is capped so one giant frame (e.g. a snapshot
    with full scrollback) can't dominate the buffer's memory. */
const MAX_DETAIL_JSON_CHARS = 16_384;
const MAX_STRING = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 6;

const SENSITIVE_KEY_RE = /api[_-]?key|authorization|token|secret|password|cookie|credential/i;
/** Long unbroken base64-ish runs (uploads, inlined images) are size, not signal. */
const BASE64ISH_RE = /^[A-Za-z0-9+/=_-]{200,}$/;

// ---------------------------------------------------------------------------
// Enablement — resolved lazily on first use so tests (and a user flipping the
// localStorage flag before load) are honored without module-import ordering.
// ---------------------------------------------------------------------------

let enabledCache: boolean | null = null;

export function isTraceEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  let enabled = false;
  try {
    if (typeof location !== 'undefined') {
      const v = new URLSearchParams(location.search).get('debug');
      if (v === '1' || v === 'true') enabled = true;
    }
  } catch {
    // location unavailable
  }
  if (!enabled) {
    enabled = safeGetString(STORAGE_KEYS.debug) === '1';
  }
  enabledCache = enabled;
  return enabled;
}

// ---------------------------------------------------------------------------
// Ring buffer + reactivity
// ---------------------------------------------------------------------------

const entries: TraceEntry[] = [];
let nextId = 1;

/** Bumped on every push; the panel re-reads the buffer when it changes. */
export const traceVersion = ref(0);
/** While true new records are dropped (panel "pause" button). */
export const tracePaused = shallowRef(false);

export function traceEntries(): readonly TraceEntry[] {
  return entries;
}

export function clearTrace(): void {
  entries.length = 0;
  traceVersion.value++;
}

function push(entry: Omit<TraceEntry, 'id' | 'ts'>): void {
  if (tracePaused.value) return;
  entries.push({ id: nextId++, ts: Date.now(), ...entry });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  traceVersion.value++;
}

// ---------------------------------------------------------------------------
// Sanitization — redact sensitive keys, truncate long strings/arrays/depth.
// ---------------------------------------------------------------------------

export function sanitizeForTrace(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'string') {
    const s = value as string;
    if (BASE64ISH_RE.test(s)) return `[base64-like, ${s.length} chars omitted]`;
    if (s.length > MAX_STRING) return `${s.slice(0, MAX_STRING)}… [+${s.length - MAX_STRING} chars]`;
    return s;
  }
  if (t !== 'object') return String(value as bigint | symbol | (() => unknown));
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (Array.isArray(value)) {
    const out: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((v) => sanitizeForTrace(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : sanitizeForTrace(v, depth + 1);
  }
  return out;
}

/** Sanitize, then hard-cap the serialized size of one entry's detail. */
function detailOf(value: unknown): unknown {
  if (value === undefined) return undefined;
  const sanitized = sanitizeForTrace(value);
  try {
    const json = JSON.stringify(sanitized);
    if (json !== undefined && json.length > MAX_DETAIL_JSON_CHARS) {
      return {
        _truncated: `detail JSON was ${json.length} chars; first ${MAX_DETAIL_JSON_CHARS} kept`,
        preview: json.slice(0, MAX_DETAIL_JSON_CHARS),
      };
    }
  } catch {
    return '[unserializable detail]';
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// REST recording — called from DaemonHttpClient
// ---------------------------------------------------------------------------

export function traceRestRequest(info: {
  method: string;
  path: string;
  url: string;
  requestId: string;
  body?: unknown;
}): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'rest',
    kind: 'rest:request',
    label: `→ ${info.method} ${info.path}`,
    method: info.method,
    path: info.path,
    requestId: info.requestId,
    detail: { url: info.url, body: detailOf(info.body) },
  });
}

export function traceRestResponse(info: {
  method: string;
  path: string;
  requestId: string;
  status: number;
  durationMs: number;
  code: number;
  msg: string;
  envelopeRequestId?: string;
  data?: unknown;
}): void {
  if (!isTraceEnabled()) return;
  const failed = info.code !== 0;
  push({
    source: 'rest',
    kind: failed ? 'rest:error' : 'rest:response',
    label: `← ${info.method} ${info.path} ${info.status} code=${info.code}${failed ? ` "${info.msg}"` : ''} ${Math.round(info.durationMs)}ms`,
    method: info.method,
    path: info.path,
    requestId: info.requestId,
    status: info.status,
    code: info.code,
    durationMs: info.durationMs,
    detail: {
      envelope: { code: info.code, msg: info.msg, request_id: info.envelopeRequestId },
      data: detailOf(info.data),
    },
  });
}

export function traceRestFailure(info: {
  method: string;
  path: string;
  requestId: string;
  phase: 'fetch' | 'parse';
  durationMs: number;
  status?: number;
  error: unknown;
}): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'rest',
    kind: 'rest:error',
    label: `✕ ${info.method} ${info.path} ${info.phase} error${info.status !== undefined ? ` (HTTP ${info.status})` : ''} ${Math.round(info.durationMs)}ms`,
    method: info.method,
    path: info.path,
    requestId: info.requestId,
    status: info.status,
    durationMs: info.durationMs,
    detail: { phase: info.phase, error: String(info.error) },
  });
}

// ---------------------------------------------------------------------------
// WS recording — called from DaemonEventSocket
// ---------------------------------------------------------------------------

export function traceWsLifecycle(event: string, detail?: unknown): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'ws',
    kind: 'ws:lifecycle',
    eventType: event,
    label: `ws ${event}`,
    detail: detailOf(detail),
  });
}

/** Outbound client frame (client_hello / subscribe / unsubscribe / abort / pong). */
export function traceWsOut(frame: unknown): void {
  if (!isTraceEnabled()) return;
  const f = (frame ?? {}) as Record<string, unknown>;
  const type = typeof f['type'] === 'string' ? (f['type'] as string) : '(unknown)';
  const payload = f['payload'] as Record<string, unknown> | undefined;
  const sessionId =
    typeof payload?.['session_id'] === 'string' ? (payload['session_id'] as string) : undefined;
  push({
    source: 'ws',
    kind: 'ws:out',
    eventType: type,
    sessionId,
    label: `→ ${type}`,
    detail: detailOf(frame),
  });
}

/** Inbound server frame — control frames and event frames alike. */
export function traceWsIn(frame: unknown): void {
  if (!isTraceEnabled()) return;
  const f = (frame ?? {}) as Record<string, unknown>;
  const type = typeof f['type'] === 'string' ? (f['type'] as string) : '(unknown)';
  const sessionId =
    typeof f['session_id'] === 'string'
      ? (f['session_id'] as string)
      : typeof (f['payload'] as Record<string, unknown> | undefined)?.['session_id'] === 'string'
        ? ((f['payload'] as Record<string, unknown>)['session_id'] as string)
        : undefined;
  const seq = typeof f['seq'] === 'number' ? (f['seq'] as number) : undefined;
  const offset = typeof f['offset'] === 'number' ? (f['offset'] as number) : undefined;
  const bits = [
    sessionId,
    seq !== undefined ? `seq=${seq}` : undefined,
    offset !== undefined ? `offset=${offset}` : undefined,
    f['volatile'] === true ? 'volatile' : undefined,
  ].filter(Boolean);
  push({
    source: 'ws',
    kind: 'ws:in',
    eventType: type,
    sessionId,
    seq,
    offset,
    label: `← ${type}${bits.length > 0 ? ` (${bits.join(' ')})` : ''}`,
    detail: detailOf(f['payload']),
  });
}

// ---------------------------------------------------------------------------
// Client-side log capture — so the exported troubleshooting log includes the
// front-end console (uncaught exceptions, rejected promises, and every console
// level: error/warn/log/info/debug) that explains a broken page, not just
// network traffic. Install-once, opt-in (only when tracing is enabled), and
// never alters runtime behavior: the original console methods and default error
// handling still run.
// ---------------------------------------------------------------------------

type ClientLogLevel = 'error' | 'warn' | 'log' | 'info' | 'debug';

const LEVEL_GLYPH: Record<ClientLogLevel, string> = {
  error: '✕',
  warn: '⚠',
  info: 'ℹ',
  debug: '·',
  log: '·',
};

function traceClientLog(level: ClientLogLevel, label: string, detail?: unknown): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'client',
    kind: `client:${level}`,
    label: `${LEVEL_GLYPH[level]} ${label}`,
    detail: detailOf(detail),
  });
}

/** Record a client-side diagnostic event (e.g. a feature's internal state, such
    as audio playback) into the troubleshooting log. No-op unless tracing is
    enabled (?debug=1 or the debug localStorage flag), so production use pays
    only a boolean check. Prefer this over raw console.* for diagnostics that
    should surface in the exported log. */
export function traceClientEvent(label: string, detail?: unknown): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'client',
    kind: 'client:event',
    label: `· ${label}`,
    detail: detailOf(detail),
  });
}

let clientCaptureInstalled = false;

/** Wire up window error + console.error/warn capture into the trace buffer. */
export function installClientErrorCapture(): void {
  if (clientCaptureInstalled || !isTraceEnabled()) return;
  clientCaptureInstalled = true;

  try {
    if (typeof window !== 'undefined') {
      window.addEventListener('error', (e: ErrorEvent) => {
        traceClientLog('error', e.message || 'window error', {
          source: e.filename,
          line: e.lineno,
          col: e.colno,
          stack: e.error instanceof Error ? e.error.stack : undefined,
        });
      });
      window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        const reason = e.reason;
        traceClientLog('error', 'unhandled promise rejection', {
          reason: reason instanceof Error ? `${reason.name}: ${reason.message}` : reason,
          stack: reason instanceof Error ? reason.stack : undefined,
        });
      });
    }
  } catch {
    // window unavailable
  }

  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = (...args: unknown[]): void => {
      try {
        traceClientLog(level, args.map(stringifyArg).join(' '), args.length > 1 ? args : args[0]);
      } catch {
        // never let tracing break logging
      }
      original.apply(console, args);
    };
  }
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Download the captured trace as a JSONL file. Reusable so the debug panel and
    any "Export log" UI action share one implementation. */
export function downloadTraceLog(list: readonly TraceEntry[] = entries): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([traceToJsonl(list)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kimi-web-log-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Serialize the given entries (default: all) as JSONL for download. */
export function traceToJsonl(list: readonly TraceEntry[] = entries): string {
  return list.map((e) => JSON.stringify(e)).join('\n');
}
