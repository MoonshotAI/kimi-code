export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type LogContext = Record<string, unknown>;

/**
 * Second argument to `log.error / warn / info / debug`.
 *
 * Three usage shapes, detected at runtime:
 *   - `Error`     → stack is extracted onto the entry
 *   - `LogContext` (object) → merged into entry context; if it contains
 *                              `{ error: Error }`, that field is pulled out
 *                              and its stack extracted (bunyan-style)
 *   - `unknown`   → typically a `catch` binding; treated as an Error if
 *                   it's an Error instance, otherwise stringified into a
 *                   `reason` field
 */
export type LogPayload = unknown;

export interface Logger {
  error(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  /**
   * Returns a new logger that adds `ctx` to every entry it emits. The bound
   * context wins over per-call payload context, so callers can't accidentally
   * overwrite ownership fields like `sessionId` / `agentId`:
   *
   *   finalCtx = { ...payloadCtx, ...boundCtx }
   *
   * Children chain — `parent.createChild({a: 1}).createChild({b: 2})` binds
   * both.
   */
  createChild(ctx: LogContext): Logger;
}

export interface LogEntry {
  readonly t: number;
  readonly level: Exclude<LogLevel, 'off'>;
  readonly msg: string;
  readonly ctx?: LogContext | undefined;
  readonly error?: { readonly message: string; readonly stack?: string } | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionLogId?: string | undefined;
}

export interface LoggingConfig {
  readonly level: LogLevel;
  readonly globalLogPath: string;
  readonly globalMaxBytes: number;
  readonly globalFiles: number;
  readonly sessionMaxBytes: number;
  readonly sessionFiles: number;
}

export interface SessionLogHandle {
  readonly logger: Logger;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionAttachInput {
  readonly sessionId: string;
  readonly sessionDir: string;
}

export interface RootLogger {
  configure(config: LoggingConfig): Promise<void>;
  attachSession(input: SessionAttachInput): SessionLogHandle;
  /** False if any sink could not flush its pending batch. */
  flush(): Promise<boolean>;
  /** False if the global sink could not flush; true when there is no global sink. */
  flushGlobal(): Promise<boolean>;
  /** False if the session sink could not flush; true when there is no active sink. */
  flushSession(sessionId: string): Promise<boolean>;
  flushSync(): void;
  isConfigured(): boolean;
  getConfig(): LoggingConfig | undefined;
}

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function levelEnabled(threshold: LogLevel, level: Exclude<LogLevel, 'off'>): boolean {
  return LOG_LEVEL_RANK[threshold] >= LOG_LEVEL_RANK[level];
}
