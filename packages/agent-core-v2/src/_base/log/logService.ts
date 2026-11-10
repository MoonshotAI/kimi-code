import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  type ILogger,
  type ILogWriter,
  type LogContext,
  type LogEntry,
  type LogEntryError,
  type LogLevel,
  type LogPayload,
  ILogService,
  levelEnabled,
} from './log';
import { createFileLogWriter, type FileLogWriter } from './fileLog';
import { ILogOptions } from './logConfig';

const pendingLogCloses = new Set<Promise<void>>();

export function trackLogClose(close: Promise<void>): void {
  const tracked = close.then(
    () => undefined,
    () => undefined,
  );
  pendingLogCloses.add(tracked);
  void tracked.finally(() => pendingLogCloses.delete(tracked));
}

export async function drainLogCloses(): Promise<void> {
  while (pendingLogCloses.size > 0) {
    await Promise.all(pendingLogCloses);
  }
}

interface ExtractedPayload {
  readonly ctx?: LogContext;
  readonly error?: LogEntryError;
}

function errorEntry(error: Error): LogEntryError {
  return { message: error.message, stack: error.stack };
}

function stringifyPayload(payload: Exclude<LogPayload, undefined>): string {
  if (typeof payload === 'string') return payload;
  try {
    const json = JSON.stringify(payload);
    return json === undefined ? String(payload) : json;
  } catch {
    return String(payload);
  }
}

function extractPayload(payload: LogPayload): ExtractedPayload | undefined {
  if (payload === undefined) return {};
  if (payload instanceof Error) return { error: errorEntry(payload) };
  if (typeof payload === 'object' && payload !== null) {
    let entries: [string, unknown][];
    try {
      entries = Object.entries(payload as Record<string, unknown>);
    } catch {
      return undefined;
    }

    let error: LogEntryError | undefined;
    const ctx: LogContext = {};
    for (const [key, value] of entries) {
      if (key === 'error' && value instanceof Error) {
        error = errorEntry(value);
        continue;
      }
      ctx[key] = value;
    }
    return {
      ...(Object.keys(ctx).length > 0 ? { ctx } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  return { ctx: { reason: stringifyPayload(payload) } };
}

export interface LogLevelState {
  level: LogLevel;
}

export class BoundLogger extends Service implements ILogger {
  constructor(
    protected readonly writer: ILogWriter,
    private readonly levelState: LogLevelState,
    private readonly bound: LogContext = {},
  ) {
    super();
  }

  child(ctx: LogContext): ILogger {
    return new BoundLogger(this.writer, this.levelState, { ...this.bound, ...ctx });
  }

  error(message: string, payload?: LogPayload): void {
    this.emit('error', message, payload);
  }
  warn(message: string, payload?: LogPayload): void {
    this.emit('warn', message, payload);
  }
  info(message: string, payload?: LogPayload): void {
    this.emit('info', message, payload);
  }
  debug(message: string, payload?: LogPayload): void {
    this.emit('debug', message, payload);
  }

  private emit(
    level: Exclude<LogLevel, 'off'>,
    message: string,
    payload?: LogPayload,
  ): void {
    if (!levelEnabled(level, this.levelState.level)) return;
    const extracted = extractPayload(payload);
    if (extracted === undefined) return;
    const payloadCtx = extracted.ctx;
    const error = extracted.error;
    const ctx =
      payloadCtx !== undefined || Object.keys(this.bound).length > 0
        ? { ...payloadCtx, ...this.bound }
        : undefined;
    const entry: LogEntry = {
      t: Date.now(),
      level,
      msg: message,
      ...(ctx !== undefined ? { ctx } : {}),
      ...(error !== undefined ? { error } : {}),
    };
    this.writer.write(entry);
  }
}

export class AppLogService extends BoundLogger implements ILogService {
  declare readonly _serviceBrand: undefined;
  private readonly sink: FileLogWriter;
  private readonly rootLevel: LogLevelState;

  constructor(@ILogOptions options: ILogOptions) {
    const sink = createFileLogWriter({
      path: options.globalLogPath,
      maxBytes: options.globalMaxBytes,
      files: options.globalFiles,
    });
    const rootLevel: LogLevelState = { level: options.level };
    super(sink, rootLevel);
    this.sink = sink;
    this.rootLevel = rootLevel;
  }

  get level(): LogLevel {
    return this.rootLevel.level;
  }

  setLevel(level: LogLevel): void {
    this.rootLevel.level = level;
  }

  flush(): Promise<void> {
    return this.sink.flush();
  }

  override dispose(): void {
    this.sink.flushSync();
    trackLogClose(this.sink.close());
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.App,
  ILogService,
  AppLogService,
  ScopeActivation.OnScopeCreated,
  'log',
);
