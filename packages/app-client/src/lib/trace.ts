
import { ref, shallowRef } from 'vue';
import type { RestAbortInfo, RestFailureInfo, RestRequestInfo, RestResponseInfo } from '@moonshot-ai/app-core/contracts';
import { logError } from '@moonshot-ai/app-core/lib';
import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

export type TraceSource = 'rest' | 'ws' | 'client';

export interface TraceEntry {
  id: number;
  ts: number;
  source: TraceSource;
  kind: string;
  label: string;
  sessionId?: string;
  agentId?: string;
  method?: string;
  path?: string;
  eventType?: string;
  seq?: number;
  status?: number;
  code?: number;
  requestId?: string;
  durationMs?: number;
  detail?: unknown;
}

const EXPORT_TRACE_EVENTS = [
  'app:load:start',
  'app:load:complete',
  'export:start',
  'export:accepted',
  'export:failed',
  'prompt:start',
  'prompt:accepted',
  'prompt:failed',
  'session:snapshot:start',
  'session:snapshot:accepted',
  'session:snapshot:failed',
  'operation:failed',
  'window:error',
  'window:unhandled-rejection',
  'vue:error',
  'ws:connection',
  'ws:error',
  'ws:resync',
  'ws:stale-reconnect',
] as const;

type ExportTraceEvent = (typeof EXPORT_TRACE_EVENTS)[number];

export interface ExportTraceMetadata {
  sessionId?: string;
  info?: string;
  status?: string;
  busy?: boolean;
  operation?: string;
  seq?: number;
  durationMs?: number;
  messageCount?: number;
  contentCount?: number;
  mediaCount?: number;
  sessionCount?: number;
  workspaceCount?: number;
  promptId?: string;
  zipBytes?: number;
  errorName?: string;
  errorCode?: number;
  requestId?: string;
  phase?: string;
  httpStatus?: number;
  fatal?: boolean;
  line?: number;
  col?: number;
}

interface ExportTraceEntry extends ExportTraceMetadata {
  ts: number;
  event: ExportTraceEvent;
}

const MAX_ENTRIES = 500;
const MAX_TOTAL_UTF8_BYTES = 256 * 1024;
const MAX_BUFFERED_ENTRIES = 5000;
const MAX_BUFFERED_UTF8_BYTES = 16 * 1024 * 1024;
const MAX_EXPORT_STRING = 200;
const MAX_DETAIL_JSON_CHARS = 16_384;
const MAX_STRING = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 6;
const MAX_RAW_JSON_CHARS = 8 * 1024 * 1024;
const VERSION_BUMP_MS = 100;
const CONSOLE_REPEAT_WINDOW_MS = 1000;

const SENSITIVE_KEY_RE = /api[_-]?key|authorization|token|secret|password|cookie|credential|email|phone|nickname|avatar/i;
const BASE64ISH_RE = /^[A-Za-z0-9+/=_-]{200,}$/;

const traceEnabled = shallowRef(safeGetString(STORAGE_KEYS.debug) === '1');

export function isTraceEnabled(): boolean {
  return traceEnabled.value;
}

export function setTraceEnabled(enabled: boolean): void {
  if (traceEnabled.value === enabled) return;
  if (enabled) safeSetString(STORAGE_KEYS.debug, '1');
  else safeRemove(STORAGE_KEYS.debug);
  traceEnabled.value = enabled;
  if (!enabled) {
    tracePaused.value = false;
    clearEntries();
    traceVersion.value++;
  }
  syncConsoleCapture();
}

const entries: TraceEntry[] = [];
const entryJson: string[] = [];
const entryBytes: number[] = [];
let totalUtf8Bytes = 0;
const rawJsonById = new Map<number, string>();
let rawTotalChars = 0;
const exportEntryJson: string[] = [];
let exportTotalUtf8Bytes = 0;
let nextId = 1;
let versionBumpTimer: ReturnType<typeof setTimeout> | undefined;
const utf8 = new TextEncoder();
const exportTraceEvents = new Set<string>(EXPORT_TRACE_EVENTS);

export const traceVersion = ref(0);
export const tracePaused = shallowRef(false);

export function traceEntries(): readonly TraceEntry[] {
  return entries;
}

export function traceRawJson(id: number): string | undefined {
  return rawJsonById.get(id);
}

function clearEntries(): void {
  clearTimeout(versionBumpTimer);
  versionBumpTimer = undefined;
  entries.length = 0;
  entryJson.length = 0;
  entryBytes.length = 0;
  totalUtf8Bytes = 0;
  rawJsonById.clear();
  rawTotalChars = 0;
}

export function clearTrace(): void {
  clearEntries();
  exportEntryJson.length = 0;
  exportTotalUtf8Bytes = 0;
  traceVersion.value++;
}

function dropRaw(id: number): void {
  const json = rawJsonById.get(id);
  if (json === undefined) return;
  rawJsonById.delete(id);
  rawTotalChars -= json.length;
}

function keepRaw(id: number, raw: unknown): void {
  if (raw === undefined || !traceEnabled.value) return;
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return;
  }
  if (json === undefined || json.length > MAX_RAW_JSON_CHARS) return;
  rawJsonById.set(id, json);
  rawTotalChars += json.length;
  for (const oldestId of rawJsonById.keys()) {
    if (rawTotalChars <= MAX_RAW_JSON_CHARS) break;
    dropRaw(oldestId);
  }
}

function push(entry: Omit<TraceEntry, 'id' | 'ts'>, raw: unknown = entry.detail): void {
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
      agentId: entry.agentId === undefined ? undefined : String(sanitizeForTrace(entry.agentId)),
      method: entry.method,
      path: entry.path,
      eventType: entry.eventType,
      seq: entry.seq,
      status: entry.status,
      code: entry.code,
      requestId: entry.requestId,
      durationMs: entry.durationMs,
      detail: detailOf(entry.detail),
    };
    const json = JSON.stringify(safeEntry);
    const bytes = utf8.encode(json).byteLength;
    if (bytes > MAX_TOTAL_UTF8_BYTES) return;
    entries.push(safeEntry);
    entryJson.push(json);
    entryBytes.push(bytes);
    totalUtf8Bytes += bytes;
    while (entries.length > MAX_BUFFERED_ENTRIES || totalUtf8Bytes > MAX_BUFFERED_UTF8_BYTES) {
      entryJson.shift();
      const removed = entries.shift();
      if (removed !== undefined) dropRaw(removed.id);
      totalUtf8Bytes -= entryBytes.shift() ?? 0;
    }
    keepRaw(safeEntry.id, raw);
  } catch {
    return;
  }
  scheduleVersionBump();
}

function scheduleVersionBump(): void {
  if (versionBumpTimer !== undefined) return;
  versionBumpTimer = setTimeout(() => {
    versionBumpTimer = undefined;
    traceVersion.value++;
  }, VERSION_BUMP_MS);
}

function exportString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= MAX_EXPORT_STRING ? value : value.slice(0, MAX_EXPORT_STRING);
}

function exportNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pushExportTrace(event: string, info?: ExportTraceMetadata): void {
  if (!exportTraceEvents.has(event)) return;
  try {
    const entry: ExportTraceEntry = {
      ts: Date.now(),
      event: event as ExportTraceEvent,
      sessionId: exportString(info?.sessionId),
      status: exportString(info?.status),
      operation: exportString(info?.operation),
      seq: exportNumber(info?.seq),
      durationMs: exportNumber(info?.durationMs),
      messageCount: exportNumber(info?.messageCount),
      contentCount: exportNumber(info?.contentCount),
      mediaCount: exportNumber(info?.mediaCount),
      sessionCount: exportNumber(info?.sessionCount),
      workspaceCount: exportNumber(info?.workspaceCount),
      promptId: exportString(info?.promptId),
      zipBytes: exportNumber(info?.zipBytes),
      errorName: exportString(info?.errorName),
      errorCode: exportNumber(info?.errorCode),
      requestId: exportString(info?.requestId),
      phase: exportString(info?.phase),
      httpStatus: exportNumber(info?.httpStatus),
      fatal: typeof info?.fatal === 'boolean' ? info.fatal : undefined,
      line: exportNumber(info?.line),
      col: exportNumber(info?.col),
    };
    const json = JSON.stringify(entry);
    const bytes = utf8.encode(json).byteLength;
    if (bytes > MAX_TOTAL_UTF8_BYTES) return;
    exportEntryJson.push(json);
    exportTotalUtf8Bytes += bytes + (exportEntryJson.length > 1 ? 1 : 0);
    while (
      exportEntryJson.length > MAX_ENTRIES ||
      exportTotalUtf8Bytes > MAX_TOTAL_UTF8_BYTES
    ) {
      const removed = exportEntryJson.shift();
      if (removed !== undefined) {
        exportTotalUtf8Bytes -= utf8.encode(removed).byteLength;
        if (exportEntryJson.length > 0) exportTotalUtf8Bytes -= 1;
      }
    }
  } catch {
    return;
  }
}

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

const SESSION_PATH = /^\/sessions\/([^/?#]+)/;

function sessionIdOfPath(path: string): string | undefined {
  return SESSION_PATH.exec(path)?.[1];
}

export function traceRestRequest(info: RestRequestInfo): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'rest',
    kind: 'rest:request',
    label: `→ ${info.method} ${info.path}`,
    method: info.method,
    path: info.path,
    requestId: info.requestId,
    sessionId: sessionIdOfPath(info.path),
    detail: { url: info.url, body: detailOf(info.body), queueMs: info.queueMs },
  }, { url: info.url, headers: info.headers, body: info.body, queueMs: info.queueMs });
}

export function traceRestResponse(info: RestResponseInfo): void {
  if (!isTraceEnabled()) return;
  const failed = info.code !== 0;
  push({
    source: 'rest',
    kind: failed ? 'rest:error' : 'rest:response',
    label: `← ${info.method} ${info.path} ${info.status} code=${info.code}${failed ? ` "${info.msg}"` : ''} ${Math.round(info.durationMs)}ms`,
    method: info.method,
    path: info.path,
    requestId: info.requestId,
    sessionId: sessionIdOfPath(info.path),
    status: info.status,
    code: info.code,
    durationMs: info.durationMs,
    detail: {
      envelope: { code: info.code, msg: info.msg, request_id: info.envelopeRequestId },
      data: detailOf(info.data),
      queueMs: info.queueMs,
    },
  }, {
    statusText: info.statusText,
    headers: info.headers,
    envelope: { code: info.code, msg: info.msg, request_id: info.envelopeRequestId, details: info.details },
    data: info.data,
    queueMs: info.queueMs,
  });
}

export function traceRestFailure(info: RestFailureInfo): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'rest',
    kind: 'rest:error',
    label: `✕ ${info.method} ${info.path} ${info.phase} error${info.status !== undefined ? ` (HTTP ${info.status})` : ''} ${Math.round(info.durationMs)}ms`,
    method: info.method,
    path: info.path,
    requestId: info.requestId,
    sessionId: sessionIdOfPath(info.path),
    status: info.status,
    durationMs: info.durationMs,
    detail: { phase: info.phase, error: String(info.error), queueMs: info.queueMs },
  }, {
    statusText: info.statusText,
    headers: info.headers,
    phase: info.phase,
    error: String(info.error),
    bodyPreview: info.bodyPreview,
    queueMs: info.queueMs,
  });
}

export function traceRestAbort(info: RestAbortInfo): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'rest',
    kind: 'rest:abort',
    label: `⊘ ${info.method} ${info.path} cancelled ${Math.round(info.durationMs)}ms`,
    method: info.method,
    path: info.path,
    requestId: info.requestId,
    sessionId: sessionIdOfPath(info.path),
    durationMs: info.durationMs,
    detail: { queueMs: info.queueMs },
  });
}

export interface HttpExchange {
  requestId: string;
  method?: string;
  path?: string;
  url?: string;
  queueMs?: number;
  sentAt?: number;
  endedAt?: number;
  durationMs?: number;
  cancelled: boolean;
  status?: number;
  statusText?: string;
  code?: number;
  msg?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  failure?: { phase: string; error: string; bodyPreview?: string };
}

export function traceHttpExchange(requestId: string): HttpExchange {
  const related = entries.filter((e) => e.source === 'rest' && e.requestId === requestId);
  const request = related.find((e) => e.kind === 'rest:request');
  const result = related.find((e) => e.kind !== 'rest:request');
  const req = request === undefined ? {} : rawRecordOf(request);
  const res = result === undefined ? {} : rawRecordOf(result);
  const envelope = recordOf(res['envelope']);
  const phase = stringOf(res['phase']);
  return {
    requestId,
    method: request?.method ?? result?.method,
    path: request?.path ?? result?.path,
    url: stringOf(req['url']),
    queueMs: exportNumber(req['queueMs']) ?? exportNumber(res['queueMs']),
    sentAt: request?.ts,
    endedAt: result?.ts,
    durationMs: result?.durationMs,
    cancelled: result?.kind === 'rest:abort',
    status: result?.status,
    statusText: stringOf(res['statusText']),
    code: result?.code,
    msg: stringOf(envelope?.['msg']),
    requestHeaders: headersOf(req['headers']),
    requestBody: req['body'],
    responseHeaders: headersOf(res['headers']),
    responseBody: envelope === undefined ? undefined : { ...envelope, data: res['data'] },
    failure: phase === undefined
      ? undefined
      : { phase, error: stringOf(res['error']) ?? '', bodyPreview: stringOf(res['bodyPreview']) },
  };
}

function rawRecordOf(entry: TraceEntry): Record<string, unknown> {
  const raw = rawJsonById.get(entry.id);
  return recordOf(raw === undefined ? entry.detail : (JSON.parse(raw) as unknown)) ?? {};
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function headersOf(value: unknown): Record<string, string> | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  );
}

export function formatTraceTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function traceWsLifecycle(event: string, detail?: unknown): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'ws',
    kind: 'ws:lifecycle',
    eventType: event,
    label: `ws ${event}`,
    detail,
  });
}

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
    agentId: frameAgentId(f),
    label: `→ ${type}`,
    detail: frame,
  });
}

export function traceWsIn(frame: unknown): void {
  if (!isTraceEnabled()) return;
  const f = (frame ?? {}) as Record<string, unknown>;
  const type = typeof f['type'] === 'string' ? (f['type'] as string) : '(unknown)';
  const payload = f['payload'] as Record<string, unknown> | undefined;
  const sessionId =
    typeof f['session_id'] === 'string'
      ? (f['session_id'] as string)
      : typeof payload?.['session_id'] === 'string'
        ? (payload['session_id'] as string)
        : undefined;
  const seq = typeof payload?.['seq'] === 'number' ? (payload['seq'] as number) : undefined;
  const bits = [sessionId, seq !== undefined ? `seq=${seq}` : undefined].filter(Boolean);
  const summary = flatFrameSummary(type, f) ?? bits.join(' ');
  push({
    source: 'ws',
    kind: 'ws:in',
    eventType: type,
    sessionId,
    agentId: frameAgentId(f),
    seq,
    label: `← ${type}${summary.length > 0 ? ` (${summary})` : ''}`,
    detail: f['payload'],
  }, frame);
}

function flatFrameSummary(type: string, frame: Record<string, unknown>): string | undefined {
  const text = (name: string): string | undefined =>
    typeof frame[name] === 'string' ? (frame[name] as string) : undefined;
  const state = (): string | undefined => {
    const status = text('status');
    const outcome = text('outcome');
    return status !== undefined && outcome !== undefined ? `${status}/${outcome}` : status;
  };
  const join = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(' ');
  switch (type) {
    case 'task': {
      const description = text('description');
      return join(
        text('agent_id'),
        text('task_id'),
        text('kind'),
        state(),
        description !== undefined ? `"${clip(description, 60)}"` : undefined,
      );
    }
    case 'task.list': {
      const tasks = Array.isArray(frame['tasks']) ? frame['tasks'] : [];
      return join(text('agent_id'), `${tasks.length} running`);
    }
    case 'task.output':
      return join(
        text('agent_id'),
        text('task_id'),
        `@${String(frame['offset'])}`,
        `+${new TextEncoder().encode(text('text') ?? '').byteLength}B`,
      );
    case 'interaction':
      return join(text('agent_id'), text('kind'), state(), text('interaction_id'));
    case 'response': {
      const msg = text('msg');
      const task = frame['task'] as Record<string, unknown> | undefined;
      return join(
        text('request_id'),
        `code=${String(frame['code'])}`,
        msg !== undefined ? `"${msg}"` : undefined,
        typeof task?.['task_id'] === 'string' ? `${task['task_id']} ${String(task['status'])}` : undefined,
      );
    }
    default:
      return undefined;
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function frameAgentId(frame: Record<string, unknown>): string | undefined {
  if (typeof frame['agent_id'] === 'string') return frame['agent_id'];
  const payload = frame['payload'] as Record<string, unknown> | undefined;
  return typeof payload?.['agent_id'] === 'string' ? payload['agent_id'] : undefined;
}

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
    detail,
  });
}

export function traceClientEvent(label: string, detail?: unknown): void {
  if (!isTraceEnabled()) return;
  push({
    source: 'client',
    kind: 'client:event',
    label: `· ${label}`,
    detail,
  });
}

export function traceKeyEvent(event: ExportTraceEvent, info?: ExportTraceMetadata): void {
  pushExportTrace(event, info);
  push({
    source: 'client',
    kind: 'client:key',
    label: event,
    sessionId: typeof info?.['sessionId'] === 'string' ? info['sessionId'] : undefined,
    seq: typeof info?.['seq'] === 'number' ? info['seq'] : undefined,
    durationMs: typeof info?.['durationMs'] === 'number' ? info['durationMs'] : undefined,
    detail: info,
  });
}

let clientCaptureInstalled = false;
let uninstallClientCapture: (() => void) | null = null;
let uninstallConsoleCapture: (() => void) | null = null;
let lastConsoleKey = '';
let lastConsoleAt = 0;

export type TraceRendererError =
  | { source: 'vue'; errorClass: string; error: unknown }
  | { source: 'window'; errorClass: string; event: ErrorEvent }
  | { source: 'rejection'; reason: unknown };

export interface TraceOptions {
  logPrefix: string;
  logFilePrefix: string;
  ignoreWindowError?: (event: ErrorEvent) => boolean;
  onRendererError?: (error: TraceRendererError) => void;
}

let traceOptions: TraceOptions = { logPrefix: '[kimi-web]', logFilePrefix: 'kimi-web-log' };

export function configureTrace(options: TraceOptions): void {
  traceOptions = options;
}

export function reportRendererException(err: unknown, info: string): void {
  const errorClass = err instanceof Error ? err.name : 'Error';
  traceKeyEvent('vue:error', { status: 'failed', errorName: errorClass, info });
  traceOptions.onRendererError?.({ source: 'vue', errorClass, error: err });
  logError(
    `${traceOptions.logPrefix} vue error (${info}): ${err instanceof Error ? err.message : String(err)}`,
    err instanceof Error ? err.stack : undefined,
  );
}

export function installClientErrorCapture(): () => void {
  if (clientCaptureInstalled) return () => uninstallClientCapture?.();
  clientCaptureInstalled = true;

  const cleanup: Array<() => void> = [];

  try {
    if (typeof window !== 'undefined') {
      const onError = (e: ErrorEvent): void => {
        if (traceOptions.ignoreWindowError?.(e) === true) return;
        const errorClass = e.error instanceof Error ? e.error.name : 'Error';
        traceKeyEvent('window:error', {
          status: 'failed',
          errorName: errorClass,
          line: e.lineno,
          col: e.colno,
        });
        traceOptions.onRendererError?.({ source: 'window', errorClass, event: e });
        logError(
          `${traceOptions.logPrefix} window error: ${e.message}`,
          e.error instanceof Error ? e.error.stack : undefined,
        );
      };
      const onUnhandledRejection = (e: PromiseRejectionEvent): void => {
        const reason = e.reason;
        traceKeyEvent('window:unhandled-rejection', {
          status: 'failed',
          errorName: reason instanceof Error ? reason.name : typeof reason,
        });
        traceOptions.onRendererError?.({ source: 'rejection', reason });
        logError(
          `${traceOptions.logPrefix} unhandled rejection: ${rejectionText(reason)}`,
          reason instanceof Error ? reason.stack : undefined,
        );
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
  } catch {}

  const dispose = (): void => {
    if (uninstallClientCapture !== dispose) return;
    for (const cleanupFunction of cleanup.toReversed()) cleanupFunction();
    uninstallClientCapture = null;
    clientCaptureInstalled = false;
    syncConsoleCapture();
  };
  uninstallClientCapture = dispose;
  syncConsoleCapture();
  return dispose;
}

function syncConsoleCapture(): void {
  const wanted = clientCaptureInstalled && traceEnabled.value;
  if (!wanted) {
    uninstallConsoleCapture?.();
    uninstallConsoleCapture = null;
    return;
  }
  if (uninstallConsoleCapture !== null) return;
  const restore: Array<() => void> = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    const wrapped = (...args: unknown[]): void => {
      try {
        const message = args.map(stringifyArg).join(' ');
        const key = `${level}:${message}`;
        const now = Date.now();
        if (key !== lastConsoleKey || now - lastConsoleAt > CONSOLE_REPEAT_WINDOW_MS) {
          traceClientLog(level, message, args.length > 1 ? args : args[0]);
        }
        lastConsoleKey = key;
        lastConsoleAt = now;
      } catch {}
      original.apply(console, args);
    };
    console[level] = wrapped;
    restore.push(() => {
      if (console[level] === wrapped) console[level] = original;
    });
  }
  uninstallConsoleCapture = () => {
    for (const restoreLevel of restore) restoreLevel();
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

export function rejectionText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  try {
    return String(reason);
  } catch {
    return '[unstringifiable reason]';
  }
}

export function downloadTraceLog(list: readonly TraceEntry[] = entries): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([traceToJsonl(list)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${traceOptions.logFilePrefix}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.jsonl`;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }, 0);
  }
}

export function traceToJsonl(list: readonly TraceEntry[] = entries): string {
  if (list === entries) {
    let start = entryJson.length;
    let bytes = 0;
    while (start > 0 && entryJson.length - start < MAX_ENTRIES) {
      const next = bytes + entryBytes[start - 1]! + (start < entryJson.length ? 1 : 0);
      if (next > MAX_TOTAL_UTF8_BYTES) break;
      bytes = next;
      start--;
    }
    return entryJson.slice(start).join('\n');
  }
  return list.map((e) => JSON.stringify(e)).join('\n');
}

export function sessionExportTraceToJsonl(): string {
  return exportEntryJson.join('\n');
}
