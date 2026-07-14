/**
 * `_base/log` (L0) — `BoundLogger` base and the App-scope `ILogService`.
 *
 * `BoundLogger` filters entries by level, extracts the payload into ctx/error,
 * merges bound context, and writes to a plain `ILogWriter`. It extends
 * `Disposable` so scope implementations can flush synchronously when their
 * scope is disposed. `AppLogService` is the App-scope binding of the single
 * `ILogService` token: it owns the global rotating file sink and reads its
 * level from `ILogOptions`.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

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

export class BoundLogger extends Disposable implements ILogger {
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
    void this.sink.close();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.App,
  ILogService,
  AppLogService,
  InstantiationType.Delayed,
  'log',
);
