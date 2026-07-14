/**
 * `_base/log` (L0) — structured logging contract.
 *
 * Defines the public logging model shared by every scope: the `LogEntry` /
 * `LogLevel` types, the `ILogger` / `ILogService` facade used by other domains
 * to emit leveled entries, and the plain `ILogWriter` sink shape. There is a
 * single `ILogService` DI token; each scope binds its own `*LogService`
 * implementation to it, so consumers just inject `@ILogService` and the scope
 * decides where entries land. `ILogWriter` is a plain (non-DI) interface — sinks
 * are created by the `*LogService` implementations, not registered.
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

export interface ILogWriter {
  write(entry: LogEntry): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
  flushSync?(): void;
}

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
