export type LogContext = Record<string, unknown>;

export type LogArgs = [message: string] | [context: LogContext, message: string];

export interface LogImpl {
  debug(...args: LogArgs): void;
  info(...args: LogArgs): void;
  warn(...args: LogArgs): void;
  error(...args: LogArgs): void;
}

const noop = (): void => {};

const defaultImpl: LogImpl = { debug: noop, info: noop, warn: noop, error: noop };

let impl: LogImpl = defaultImpl;

export const log: LogImpl = {
  debug: (...args) => impl.debug(...args),
  info: (...args) => impl.info(...args),
  warn: (...args) => impl.warn(...args),
  error: (...args) => impl.error(...args),
};

export function setLog(next?: LogImpl): void {
  impl = next ?? defaultImpl;
}
