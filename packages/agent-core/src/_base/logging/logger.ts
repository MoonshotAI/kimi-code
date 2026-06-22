import { join } from 'pathe';

import { extractError, formatEntry, redactCtx } from './formatter';
import { RotatingFileSink } from './sinks';
import {
  type LogContext,
  type LogEntry,
  type LogLevel,
  type LogPayload,
  type Logger,
  type LoggingConfig,
  type RootLogger,
  type SessionAttachInput,
  type SessionLogHandle,
  levelEnabled,
} from './types';

const ROOT_SYMBOL = Symbol.for('kimi.logger.root');
const SESSION_LOG_ID = Symbol('kimi.logger.sessionLogId');
const LLM_REQUEST_SESSION_LOG_OMITTED_CONTEXT_KEYS = ['sessionId'];
const MAIN_LLM_REQUEST_SESSION_LOG_OMITTED_CONTEXT_KEYS = ['sessionId', 'agentId'];
let nextSessionLogId = 0;

interface SessionEntry {
  readonly logId: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly sink: RotatingFileSink;
  state: 'open' | 'closing';
  closePromise: Promise<void> | undefined;
  refCount: number;
}

class RootLoggerImpl implements RootLogger {
  private config: LoggingConfig | undefined;
  private globalSink: RotatingFileSink | undefined;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionsById = new Map<string, Set<string>>();

  isConfigured(): boolean {
    return this.config !== undefined;
  }

  getConfig(): LoggingConfig | undefined {
    return this.config;
  }

  configure(config: LoggingConfig): Promise<void> {
    if (this.config !== undefined && sameLoggingConfig(this.config, config)) {
      return Promise.resolve();
    }
    const oldGlobalSink = this.globalSink;
    this.config = config;
    this.globalSink = makeGlobalSink(config);
    return oldGlobalSink?.close() ?? Promise.resolve();
  }

  attachSession(input: SessionAttachInput): SessionLogHandle {
    const existing = this.findOpenSession(input.sessionId, input.sessionDir);
    if (existing !== undefined) {
      existing.refCount += 1;
      return makeHandle(existing);
    }
    const config = this.config;
    if (config === undefined || config.level === 'off') {
      return makeNoopHandle(input.sessionId);
    }
    const sink = new RotatingFileSink({
      path: join(input.sessionDir, 'logs', 'kimi-code.log'),
      maxBytes: config.sessionMaxBytes,
      files: config.sessionFiles,
    });
    const entry: SessionEntry = {
      logId: `session-log-${String(++nextSessionLogId)}`,
      sessionId: input.sessionId,
      sessionDir: input.sessionDir,
      sink,
      state: 'open',
      closePromise: undefined,
      refCount: 1,
    };
    this.sessions.set(entry.logId, entry);
    this.trackSessionId(entry);
    return makeHandle(entry);
  }

  async flush(): Promise<boolean> {
    const tasks: Promise<boolean>[] = [];
    if (this.globalSink !== undefined) tasks.push(this.globalSink.flush());
    for (const entry of this.sessions.values()) {
      tasks.push(this.flushEntry(entry));
    }
    if (tasks.length === 0) return true;
    const results = await Promise.all(tasks);
    return results.every(Boolean);
  }

  async flushGlobal(): Promise<boolean> {
    if (this.globalSink === undefined) return true;
    return this.globalSink.flush();
  }

  async flushSession(sessionId: string): Promise<boolean> {
    const entries = this.getEntriesForSessionId(sessionId);
    if (entries.length === 0) return true;
    const results = await Promise.all(entries.map((entry) => this.flushEntry(entry)));
    return results.every(Boolean);
  }

  flushSync(): void {
    const deadline = Date.now() + 200;
    this.globalSink?.flushSync();
    for (const entry of this.sessions.values()) {
      if (entry.state !== 'open') continue;
      if (Date.now() > deadline) break;
      entry.sink.flushSync();
    }
  }

  emit(entry: LogEntry): void {
    const config = this.config;
    if (config === undefined || config.level === 'off') return;
    if (!levelEnabled(config.level, entry.level)) return;

    const session = this.resolveSessionEntry(entry);
    if (session !== undefined) {
      const omitContextKeys = llmRequestSessionLogOmittedKeys(entry);
      const sessionFormatted = formatEntry(entry, {
        omitContextKeys,
      });
      if (!sessionFormatted.dropped) {
        session.sink.enqueue(sessionFormatted.text + '\n');
      }
    } else {
      const formatted = formatEntry(entry);
      if (formatted.dropped) return;
      this.globalSink?.enqueue(formatted.text + '\n');
    }
  }

  detachSession(logId: string): Promise<void> {
    const entry = this.sessions.get(logId);
    if (entry === undefined) return Promise.resolve();
    if (entry.state === 'closing') return entry.closePromise ?? Promise.resolve();
    entry.refCount -= 1;
    if (entry.refCount > 0) return Promise.resolve();
    entry.state = 'closing';
    entry.closePromise = entry.sink.close().finally(() => {
      if (this.sessions.get(logId) === entry) {
        this.sessions.delete(logId);
        this.untrackSessionId(entry);
      }
    });
    return entry.closePromise;
  }

  /** @internal — vitest only. */
  async __shutdownForTest(): Promise<void> {
    const closes: Promise<void>[] = [];
    if (this.globalSink !== undefined) closes.push(this.globalSink.close());
    for (const entry of this.sessions.values()) {
      if (entry.state === 'closing') {
        if (entry.closePromise !== undefined) closes.push(entry.closePromise);
      } else {
        entry.state = 'closing';
        entry.closePromise = entry.sink.close();
        closes.push(entry.closePromise);
      }
    }
    this.sessions.clear();
    this.sessionsById.clear();
    this.globalSink = undefined;
    this.config = undefined;
    await Promise.allSettled(closes);
  }

  private findOpenSession(sessionId: string, sessionDir: string): SessionEntry | undefined {
    for (const entry of this.getEntriesForSessionId(sessionId)) {
      if (entry.sessionDir === sessionDir && entry.state === 'open') return entry;
    }
    return undefined;
  }

  private trackSessionId(entry: SessionEntry): void {
    const ids = this.sessionsById.get(entry.sessionId) ?? new Set<string>();
    ids.add(entry.logId);
    this.sessionsById.set(entry.sessionId, ids);
  }

  private untrackSessionId(entry: SessionEntry): void {
    const ids = this.sessionsById.get(entry.sessionId);
    if (ids === undefined) return;
    ids.delete(entry.logId);
    if (ids.size === 0) this.sessionsById.delete(entry.sessionId);
  }

  private getEntriesForSessionId(sessionId: string): SessionEntry[] {
    const ids = this.sessionsById.get(sessionId);
    if (ids === undefined) return [];
    return [...ids]
      .map((id) => this.sessions.get(id))
      .filter((entry): entry is SessionEntry => entry !== undefined);
  }

  private resolveSessionEntry(entry: LogEntry): SessionEntry | undefined {
    if (entry.sessionLogId !== undefined) {
      const session = this.sessions.get(entry.sessionLogId);
      return session?.state === 'open' ? session : undefined;
    }
    if (entry.sessionId === undefined) return undefined;
    const openEntries = this.getEntriesForSessionId(entry.sessionId).filter(
      (item) => item.state === 'open',
    );
    return openEntries.length === 1 ? openEntries[0] : undefined;
  }

  private async flushEntry(entry: SessionEntry): Promise<boolean> {
    if (entry.state === 'closing') {
      await entry.closePromise;
      return true;
    }
    return entry.sink.flush();
  }
}

function llmRequestSessionLogOmittedKeys(entry: LogEntry): readonly string[] {
  return entry.ctx?.['agentId'] === 'main'
    ? MAIN_LLM_REQUEST_SESSION_LOG_OMITTED_CONTEXT_KEYS
    : LLM_REQUEST_SESSION_LOG_OMITTED_CONTEXT_KEYS;
}

function makeHandle(entry: SessionEntry): SessionLogHandle {
  let closed = false;
  return {
    logger: log.createChild({
      sessionId: entry.sessionId,
      [SESSION_LOG_ID]: entry.logId,
    } as LogContext),
    async flush() {
      if (entry.state === 'closing') {
        await entry.closePromise;
      } else {
        await entry.sink.flush();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await getRootInternal().detachSession(entry.logId);
    },
  };
}

function makeNoopHandle(sessionId: string): SessionLogHandle {
  return {
    logger: log.createChild({ sessionId }),
    async flush() {},
    async close() {},
  };
}

function getRootInternal(): RootLoggerImpl {
  const globalAny = globalThis as Record<symbol, unknown>;
  const existing = globalAny[ROOT_SYMBOL];
  if (existing instanceof RootLoggerImpl) return existing;
  const fresh = new RootLoggerImpl();
  globalAny[ROOT_SYMBOL] = fresh;
  return fresh;
}

export function getRootLogger(): RootLogger {
  return getRootInternal();
}

export function flushDiagnosticLogs(): Promise<boolean> {
  return getRootInternal().flush();
}

class LoggerImpl implements Logger {
  constructor(private readonly boundCtx: LogContext) {}

  error(message: string, payload?: LogPayload): void {
    this.emitAt('error', message, payload);
  }
  warn(message: string, payload?: LogPayload): void {
    this.emitAt('warn', message, payload);
  }
  info(message: string, payload?: LogPayload): void {
    this.emitAt('info', message, payload);
  }
  debug(message: string, payload?: LogPayload): void {
    this.emitAt('debug', message, payload);
  }

  createChild(ctx: LogContext): Logger {
    return new LoggerImpl({ ...this.boundCtx, ...ctx });
  }

  private emitAt(
    level: Exclude<LogLevel, 'off'>,
    message: string,
    payload: LogPayload,
  ): void {
    const root = getRootInternal();
    if (!root.isConfigured()) return;
    try {
      const { ctx: payloadCtx, error } = resolvePayload(payload);
      // Bound ctx wins so call-site can't overwrite ownership fields.
      const ctx = mergeCtx(payloadCtx, this.boundCtx);
      const sessionId = ctx?.['sessionId'];
      const sessionLogId = (ctx as InternalLogContext | undefined)?.[SESSION_LOG_ID];
      root.emit({
        t: Date.now(),
        level,
        msg: message,
        ctx: stripInternalCtx(ctx),
        error,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        sessionLogId: typeof sessionLogId === 'string' ? sessionLogId : undefined,
      });
    } catch {
      // Diagnostic logging is best-effort and must never affect main control flow.
    }
  }
}

type InternalLogContext = LogContext & { [SESSION_LOG_ID]?: unknown };

function stripInternalCtx(ctx: LogContext | undefined): LogContext | undefined {
  if (ctx === undefined) return undefined;
  if (!(SESSION_LOG_ID in ctx)) return ctx;
  const { [SESSION_LOG_ID]: _internal, ...visible } = ctx as InternalLogContext;
  return visible;
}

function makeGlobalSink(config: LoggingConfig): RotatingFileSink | undefined {
  if (config.level === 'off') return undefined;
  return new RotatingFileSink({
    path: config.globalLogPath,
    maxBytes: config.globalMaxBytes,
    files: config.globalFiles,
  });
}

function sameLoggingConfig(a: LoggingConfig, b: LoggingConfig): boolean {
  return (
    a.level === b.level &&
    a.globalLogPath === b.globalLogPath &&
    a.globalMaxBytes === b.globalMaxBytes &&
    a.globalFiles === b.globalFiles &&
    a.sessionMaxBytes === b.sessionMaxBytes &&
    a.sessionFiles === b.sessionFiles
  );
}

function resolvePayload(
  payload: LogPayload,
): { ctx: LogContext | undefined; error: LogEntry['error'] } {
  if (payload === undefined || payload === null) {
    return { ctx: undefined, error: undefined };
  }
  if (payload instanceof Error) {
    return { ctx: undefined, error: extractError(payload) };
  }
  if (typeof payload === 'object') {
    // bunyan-style: a `{ error: Error }` field is hoisted out, stack extracted.
    const obj = payload as Record<string, unknown>;
    if (obj['error'] instanceof Error) {
      const { error: errValue, ...rest } = obj;
      return { ctx: rest as LogContext, error: extractError(errValue) };
    }
    return { ctx: obj as LogContext, error: undefined };
  }
  if (
    typeof payload === 'string' ||
    typeof payload === 'number' ||
    typeof payload === 'boolean' ||
    typeof payload === 'bigint' ||
    typeof payload === 'symbol'
  ) {
    return { ctx: { reason: String(payload) }, error: undefined };
  }
  if (typeof payload === 'function') {
    const reason = payload.name === '' ? '[Function]' : `[Function: ${payload.name}]`;
    return { ctx: { reason }, error: undefined };
  }
  return { ctx: { reason: Object.prototype.toString.call(payload) }, error: undefined };
}

function mergeCtx(
  payloadCtx: LogContext | undefined,
  boundCtx: LogContext,
): LogContext | undefined {
  const boundHasKeys = Object.keys(boundCtx).length > 0;
  if (!boundHasKeys) return payloadCtx;
  if (payloadCtx === undefined) return { ...boundCtx };
  return { ...payloadCtx, ...boundCtx };
}

/**
 * Root logger. Import and use directly for events that don't belong to any
 * session (CLI startup, harness construction, etc.):
 *
 *   import { log } from 'kimi-code-sdk';
 *   log.info('kimi-code starting', { version });
 *
 * For events scoped to a session or agent, use the parent's `log` field:
 *
 *   session.log.error('mcp initial load failed', error);
 *   agent.log.error('turn failed', { turnId, error });
 *
 * Late-binding: methods look up the current `RootLogger` on every call, so
 * importing `log` at module load (before `KimiHarness` configures the root)
 * is safe — calls during the pre-configure window are silent noops.
 */
export const log: Logger = new LoggerImpl({});

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return redactCtx({ value: value as unknown })['value'] as T;
}

/** @internal — vitest only. */
export async function __resetRootLoggerForTest(): Promise<void> {
  const globalAny = globalThis as Record<symbol, unknown>;
  const existing = globalAny[ROOT_SYMBOL];
  if (existing instanceof RootLoggerImpl) {
    await existing.__shutdownForTest();
  }
  globalAny[ROOT_SYMBOL] = undefined;
}

export function resolveGlobalLogPath(homeDir: string): string {
  return join(homeDir, 'logs', 'kimi-code.log');
}
