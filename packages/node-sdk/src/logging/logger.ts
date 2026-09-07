import { join } from 'node:path';

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
  levelEnabled,
} from './types';

const ROOT_SYMBOL = Symbol.for('kimi.logger.root');

class RootLoggerImpl implements RootLogger {
  private config: LoggingConfig | undefined;
  private globalSink: RotatingFileSink | undefined;

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

  async flush(): Promise<boolean> {
    if (this.globalSink === undefined) return true;
    return this.globalSink.flush();
  }

  flushSync(): void {
    this.globalSink?.flushSync();
  }

  emit(entry: LogEntry): void {
    const config = this.config;
    if (config === undefined || config.level === 'off') return;
    if (!levelEnabled(config.level, entry.level)) return;
    const formatted = formatEntry(entry);
    if (formatted.dropped) return;
    this.globalSink?.enqueue(formatted.text + '\n');
  }

  async __shutdownForTest(): Promise<void> {
    const close = this.globalSink?.close();
    this.globalSink = undefined;
    this.config = undefined;
    await close;
  }
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

export function flushDiagnosticLogsSync(): void {
  getRootInternal().flushSync();
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
      const ctx = mergeCtx(payloadCtx, this.boundCtx);
      root.emit({
        t: Date.now(),
        level,
        msg: message,
        ctx,
        error,
      });
    } catch {
    }
  }
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

export const log: Logger = new LoggerImpl({});

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return redactCtx({ value: value as unknown })['value'] as T;
}

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
