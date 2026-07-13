// apps/kimi-web/src/debug/trace.ts
// KAP/daemon trace — a side-channel recording of low-frequency client
// lifecycle events plus opt-in REST/WS/console diagnostics.
//
// Full diagnostics are opt-in via `?debug=1` or
// `localStorage["kimi-web.debug"]="1"`; key lifecycle metadata is always on.
// Recording NEVER changes request/WS behavior: callers pass data in, errors
// here must not propagate. The shared store is bounded by count and UTF-8 size
// so it can be included in a session export without retaining app data.

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

const MAX_ENTRIES = 500;
const MAX_TOTAL_UTF8_BYTES = 256 * 1024;
/** A single entry's detail JSON is capped so one giant frame (e.g. a snapshot
    with full scrollback) can't dominate the buffer's memory. */
const MAX_DETAIL_JSON_CHARS = 16_384;
const MAX_STRING = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
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
const entryJson: string[] = [];
let totalUtf8Bytes = 0;
let nextId = 1;
const utf8 = new TextEncoder();

/** Bumped on every push; the panel re-reads the buffer when it changes. */
export const traceVersion = ref(0);
/** While true new records are dropped (panel "pause" button). */
export const tracePaused = shallowRef(false);

export function traceEntries(): readonly TraceEntry[] {
  return entries;
}

export function clearTrace(): void {
  entries.length = 0;
  entryJson.length = 0;
  totalUtf8Bytes = 0;
  traceVersion.value++;
}

function push(entry: Omit<TraceEntry, 'id' | 'ts'>): void {
  if (tracePaused.value) return;
  try {
    const safeEntry: TraceEntry = {
      id: nextId++,
      ts: Date.now(),
      source: entry.source,
      kind: String(sanitizeForTrace(entry.kind)),
      label: String(sanitizeForTrace(entry.label)),
      sessionId:
        entry.sessionId === undefined ? undefined : String(sanitizeForTrace(entry.sessionId)),
      method: entry.method,
      path: entry.path,
      eventType: entry.eventType,
      seq: entry.seq,
      offset: entry.offset,
      status: entry.status,
      code: entry.code,
      requestId: entry.requestId,
      durationMs: entry.durationMs,
      detail: detailOf(entry.detail),
    };
    const json = JSON.stringify(safeEntry);
    const bytes = utf8.encode(json).byteLength;
    // A single impossible-to-fit entry carries no useful export signal and
    // must not make traceToJsonl exceed the server's request limit.
    if (bytes > MAX_TOTAL_UTF8_BYTES) return;
    entries.push(safeEntry);
    entryJson.push(json);
    totalUtf8Bytes += bytes + (entryJson.length > 1 ? 1 : 0);
    while (entries.length > MAX_ENTRIES || totalUtf8Bytes > MAX_TOTAL_UTF8_BYTES) {
      const removedJson = entryJson.shift();
      entries.shift();
      if (removedJson !== undefined) {
        totalUtf8Bytes -= utf8.encode(removedJson).byteLength;
        // Removing a non-empty buffer's first line also removes the newline
        // that used to precede the new first line.
        if (entryJson.length > 0) totalUtf8Bytes -= 1;
      }
    }
  } catch {
    return;
  }
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
  const objectEntries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of objectEntries.slice(0, MAX_OBJECT_KEYS)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : sanitizeForTrace(v, depth + 1);
  }
  if (objectEntries.length > MAX_OBJECT_KEYS) {
    out['_truncatedKeys'] = objectEntries.length - MAX_OBJECT_KEYS;
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

/** Always-on, low-frequency product-path event. Callers must pass metadata
 * only (ids, statuses, cursors, durations and counts), never user content. */
export function traceKeyEvent(
  label: string,
  info?: Record<string, string | number | boolean | null | undefined>,
): void {
  push({
    source: 'client',
    kind: 'client:key',
    label,
    sessionId: typeof info?.['sessionId'] === 'string' ? info['sessionId'] : undefined,
    seq: typeof info?.['seq'] === 'number' ? info['seq'] : undefined,
    durationMs: typeof info?.['durationMs'] === 'number' ? info['durationMs'] : undefined,
    detail: info,
  });
}

let clientCaptureInstalled = false;
let uninstallClientCapture: (() => void) | null = null;

/** Wire up always-on window failures and debug-only console capture. */
export function installClientErrorCapture(): void {
  if (clientCaptureInstalled) return;
  clientCaptureInstalled = true;

  const cleanup: Array<() => void> = [];

  try {
    if (typeof window !== 'undefined') {
      const onError = (e: ErrorEvent): void => {
        traceKeyEvent('window:error', {
          status: 'failed',
          errorName: e.error instanceof Error ? e.error.name : 'Error',
          line: e.lineno,
          col: e.colno,
        });
      };
      const onUnhandledRejection = (e: PromiseRejectionEvent): void => {
        const reason = e.reason;
        traceKeyEvent('window:unhandled-rejection', {
          status: 'failed',
          errorName: reason instanceof Error ? reason.name : typeof reason,
        });
      };
      window.addEventListener('error', onError);
      window.addEventListener('unhandledrejection', onUnhandledRejection);
      cleanup.push(() => {
        window.removeEventListener('error', onError);
      });
      cleanup.push(() => {
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
      });
    }
  } catch {
    // window unavailable
  }

  if (isTraceEnabled()) {
    for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      const wrapped = (...args: unknown[]): void => {
        try {
          traceClientLog(level, args.map(stringifyArg).join(' '), args.length > 1 ? args : args[0]);
        } catch {
          // never let tracing break logging
        }
        original.apply(console, args);
      };
      console[level] = wrapped;
      cleanup.push(() => {
        if (console[level] === wrapped) console[level] = original;
      });
    }
  }

  uninstallClientCapture = (): void => {
    for (const dispose of cleanup.toReversed()) dispose();
    uninstallClientCapture = null;
    clientCaptureInstalled = false;
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => uninstallClientCapture?.());
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
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `kimi-web-log-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.jsonl`;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Object URL cleanup is best-effort in restricted browser contexts.
      }
    }, 0);
  }
}

/** Serialize the given entries (default: all) as JSONL for download. */
export function traceToJsonl(list: readonly TraceEntry[] = entries): string {
  if (list === entries) return entryJson.join('\n');
  return list.map((e) => JSON.stringify(e)).join('\n');
}
