import { resolveGlobalLogPath } from './logger';
import type { LogLevel, LoggingConfig } from './types';

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_GLOBAL_MAX_BYTES = 6 * 1024 * 1024; // 6 MB
export const DEFAULT_GLOBAL_FILES = 5; // 6 MB x 5 = 30 MB
export const DEFAULT_SESSION_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_SESSION_FILES = 3; // 5 MB x 3 = 15 MB

export interface ResolveLoggingInput {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Build the runtime `LoggingConfig` from env vars + defaults.
 *
 * v1 deliberately does not read `config.toml [logging]` — the schema is in
 * flux and reading it adds a startup-time failure surface. Users who need to
 * override the defaults set env vars:
 *
 *   KIMI_LOG_LEVEL=debug
 *   KIMI_LOG_GLOBAL_MAX_BYTES=... KIMI_LOG_GLOBAL_FILES=...
 *   KIMI_LOG_SESSION_MAX_BYTES=... KIMI_LOG_SESSION_FILES=...
 */
export function resolveLoggingConfig(input: ResolveLoggingInput): LoggingConfig {
  const env = input.env ?? process.env;
  return {
    level: parseLevel(env['KIMI_LOG_LEVEL']) ?? DEFAULT_LOG_LEVEL,
    globalLogPath: resolveGlobalLogPath(input.homeDir),
    globalMaxBytes: parsePositiveInt(env['KIMI_LOG_GLOBAL_MAX_BYTES']) ?? DEFAULT_GLOBAL_MAX_BYTES,
    globalFiles: parsePositiveInt(env['KIMI_LOG_GLOBAL_FILES']) ?? DEFAULT_GLOBAL_FILES,
    sessionMaxBytes:
      parsePositiveInt(env['KIMI_LOG_SESSION_MAX_BYTES']) ?? DEFAULT_SESSION_MAX_BYTES,
    sessionFiles: parsePositiveInt(env['KIMI_LOG_SESSION_FILES']) ?? DEFAULT_SESSION_FILES,
  };
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'off' || v === 'error' || v === 'warn' || v === 'info' || v === 'debug') return v;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
