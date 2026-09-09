import { resolveGlobalLogPath } from './logger';
import type { LogLevel, LoggingConfig } from './types';

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_GLOBAL_MAX_BYTES = 6 * 1024 * 1024;
export const DEFAULT_GLOBAL_FILES = 5;
export const DEFAULT_SESSION_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_SESSION_FILES = 3;

export interface ResolveLoggingInput {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

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
