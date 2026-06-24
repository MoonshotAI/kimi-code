/**
 * `log` domain (L1) — Core-scope logging contract.
 *
 * Ported and reshaped from `packages/agent-core/src/logging/**`. The v1
 * `RootLoggerImpl` was a `globalThis` singleton; v2 exposes `ILogService` as
 * a Core-scope DI service with no implicit global state, so it can be
 * replaced or stubbed in tests. Session/Agent services obtain a bound child
 * via `log.child({ sessionId, agentId })` rather than attaching sinks
 * themselves.
 *
 * File rotation / persistence is a sink concern (`ILogSink`); the engine
 * ships a console + in-memory sink, and the server can register a rotating
 * file sink in its place.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type LogContext = Record<string, unknown>;

/** Second argument to log methods — arbitrary payload or an `Error`. */
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

/** Destination for emitted log entries. */
export interface ILogSink {
  write(entry: LogEntry): void;
}

export const ILogSink: ServiceIdentifier<ILogSink> =
  createDecorator<ILogSink>('logSink');

export interface ILogger {
  error(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  /**
   * Returns a child logger that merges `ctx` into every entry it emits. Bound
   * context wins over per-call payload context, so ownership fields like
   * `sessionId` cannot be overwritten by callers.
   */
  child(ctx: LogContext): ILogger;
}

/**
 * Core-scope log service. Extends `ILogger` with level control. The root
 * service is obtained from the Core scope; scoped services call `.child(...)`
 * to bind their own context.
 */
export interface ILogService extends ILogger {
  readonly _serviceBrand: undefined;
  readonly level: LogLevel;
  setLevel(level: LogLevel): void;
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
