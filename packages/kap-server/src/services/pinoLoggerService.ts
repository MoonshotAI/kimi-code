/**
 * Pino logger factory for the server process.
 *
 * Produces the `ServerLogger` handed to Fastify via `loggerInstance`. Unlike the
 * v1 server, server-v2 does not adapt this logger into the engine's
 * `ILogService` — `agent-core-v2` registers its own `ILogService` at Core scope,
 * so the HTTP-layer logger stays a plain pino instance.
 *
 * Output is always newline-delimited JSON (pino's default). The HTTP status is
 * not logged on the access line — every response is HTTP 200 by design, with
 * the business outcome carried in the envelope `code` (see `requestLogging.ts`).
 */

import { pino, type Logger, type LoggerOptions } from 'pino';

export type ServerLogger = Logger;

export type ServerLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  level: ServerLogLevel;
}

export function createServerLogger(opts: CreateLoggerOptions): ServerLogger {
  const base: LoggerOptions = {
    level: opts.level,
    base: { name: 'kimi-server-v2' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return pino(base);
}
