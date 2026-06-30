/**
 * `log` domain (L1) — `ILogService` implementation and built-in writers.
 *
 * Filters entries by the configured `LogLevel` and writes them to the bound
 * `ILogWriterService`; provides the console and in-memory `ILogWriterService` implementations.
 * Bound at Core scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type ILogger,
  type LogContext,
  type LogEntry,
  type LogEntryError,
  type LogLevel,
  type LogPayload,
  ILogService,
  ILogWriterService,
  levelEnabled,
} from './log';

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

export class MemoryLogWriterService implements ILogWriterService {
  declare readonly _serviceBrand: undefined;
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

export class ConsoleLogWriterService implements ILogWriterService {
  declare readonly _serviceBrand: undefined;
  write(entry: LogEntry): void {
    const line = entry.ctx !== undefined ? `${entry.msg} ${JSON.stringify(entry.ctx)}` : entry.msg;
    switch (entry.level) {
      case 'error':
        // eslint-disable-next-line no-console
        console.error(line);
        break;
      case 'warn':
        // eslint-disable-next-line no-console
        console.warn(line);
        break;
      case 'debug':
        // eslint-disable-next-line no-console
        console.debug(line);
        break;
      default:
        // eslint-disable-next-line no-console
        console.log(line);
    }
  }
}

export interface LogLevelState {
  level: LogLevel;
}

export class BoundLogger implements ILogger {
  constructor(
    protected readonly writer: ILogWriterService,
    private readonly levelState: LogLevelState,
    private readonly bound: LogContext = {},
  ) {}

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

export class LogService extends BoundLogger implements ILogService {
  declare readonly _serviceBrand: undefined;
  private readonly rootLevel: LogLevelState;

  constructor(@ILogWriterService writer: ILogWriterService) {
    const rootLevel: LogLevelState = { level: 'info' };
    super(writer, rootLevel);
    this.rootLevel = rootLevel;
  }

  get level(): LogLevel {
    return this.rootLevel.level;
  }

  setLevel(level: LogLevel): void {
    this.rootLevel.level = level;
  }

  flush(): Promise<void> {
    return this.writer.flush?.() ?? Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Core,
  ILogWriterService,
  ConsoleLogWriterService,
  InstantiationType.Eager,
  'log',
);
registerScopedService(
  LifecycleScope.Core,
  ILogService,
  LogService,
  InstantiationType.Eager,
  'log',
);
