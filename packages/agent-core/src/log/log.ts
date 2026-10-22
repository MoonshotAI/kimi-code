import { now } from '#/utils/now';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogLevelConfig = LogLevel | 'off';

export interface LogError {
  readonly message: string;
  readonly stack?: string;
}

export interface LogEntry {
  readonly t: number;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly error?: LogError;
}

export interface LogWriter {
  write(entry: LogEntry): void;
}

export interface Logger {
  readonly level: LogLevelConfig;
  setLevel(level: LogLevelConfig): void;
  error(message: string, context?: Record<string, unknown>, error?: unknown): void;
  warn(message: string, context?: Record<string, unknown>, error?: unknown): void;
  info(message: string, context?: Record<string, unknown>, error?: unknown): void;
  debug(message: string, context?: Record<string, unknown>, error?: unknown): void;
  child(context: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: Record<LogLevelConfig, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function levelEnabled(level: LogLevel, config: LogLevelConfig): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[config] && config !== 'off';
}

function errorOf(error: unknown): LogError {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

interface LevelState {
  level: LogLevelConfig;
}

function boundLogger(
  writer: LogWriter,
  state: LevelState,
  bound: Record<string, unknown> | undefined,
): Logger {
  const emit = (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: unknown,
  ): void => {
    if (!levelEnabled(level, state.level)) return;
    const merged = bound === undefined ? context : { ...context, ...bound };
    writer.write({
      t: now(),
      level,
      message,
      context: merged,
      error: error === undefined ? undefined : errorOf(error),
    });
  };
  return {
    get level(): LogLevelConfig {
      return state.level;
    },
    setLevel(level: LogLevelConfig): void {
      state.level = level;
    },
    error: (message, context?, error?) => emit('error', message, context, error),
    warn: (message, context?, error?) => emit('warn', message, context, error),
    info: (message, context?, error?) => emit('info', message, context, error),
    debug: (message, context?, error?) => emit('debug', message, context, error),
    child: (context) =>
      boundLogger(writer, state, bound === undefined ? context : { ...bound, ...context }),
  };
}

export function createLogger(writer: LogWriter, options: { level?: LogLevelConfig } = {}): Logger {
  return boundLogger(writer, { level: options.level ?? 'info' }, undefined);
}

export const silentLogger: Logger = createLogger(
  {
    write: () => {},
  },
  { level: 'off' },
);
