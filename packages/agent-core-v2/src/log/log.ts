/**
 * `log` domain (L1) — structured logging facade.
 *
 * Defines the public contract of logging: the `LogEntry` / `LogLevel` model,
 * the `ILogger` / `ILogService` used by other domains to emit leveled entries,
 * the `ILogWriterService` they are written to, and the per-session `ISessionLogService`
 * that owns a session-scoped sink. `ILogService` is Core-scoped;
 * `ISessionLogService` is Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type LogContext = Record<string, unknown>;

export type LogPayload = unknown;

export interface LogEntryError {
  readonly message: string;
  readonly stack?: string;
}

export interface LogEntry {
  readonly t: number;
  readonly level: Exclude<LogLevel, 'off'>;
  readonly msg: string;
  readonly ctx?: LogContext;
  readonly error?: LogEntryError;
}

export interface ILogWriterService {
  readonly _serviceBrand: undefined;
  write(entry: LogEntry): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export const ILogWriterService: ServiceIdentifier<ILogWriterService> =
  createDecorator<ILogWriterService>('logWriterService');

export interface ILogger {
  error(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  child(ctx: LogContext): ILogger;
}

export interface ILogService extends ILogger {
  readonly _serviceBrand: undefined;
  readonly level: LogLevel;
  setLevel(level: LogLevel): void;
  flush(): Promise<void>;
}

export const ILogService: ServiceIdentifier<ILogService> =
  createDecorator<ILogService>('logService');

const LEVEL_ORDER: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function levelEnabled(level: LogLevel, configured: LogLevel): boolean {
  if (level === 'off' || configured === 'off') return false;
  return LEVEL_ORDER[level] <= LEVEL_ORDER[configured];
}

export interface ISessionLogService extends ILogger {
  readonly _serviceBrand: undefined;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const ISessionLogService: ServiceIdentifier<ISessionLogService> =
  createDecorator<ISessionLogService>('sessionLogService');
