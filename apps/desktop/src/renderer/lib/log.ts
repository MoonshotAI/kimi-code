// apps/web/src/lib/log.ts
// Shared renderer diagnostic logger. Every call mirrors to the devtools
// console; on the desktop app the line is also forwarded over the
// `window.kimiDesktop.log` bridge to the main-process log file (the sandboxed
// renderer has no fs access, and packaged builds show no console). Web and
// old bridges without the method degrade to console-only. Logging must never
// break the caller: bridge failures are swallowed.

type LogLevel = 'info' | 'warn' | 'error';

type LogBridge = {
  log?: (level: LogLevel, message: string, detail?: unknown) => void;
};

function bridge(): LogBridge | undefined {
  return (window as { kimiDesktop?: LogBridge }).kimiDesktop;
}

function forward(level: LogLevel, message: string, rest: unknown[]): void {
  const detail = rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest;
  try {
    bridge()?.log?.(level, message, detail);
  } catch {
    // The console mirror above already kept the line; never propagate.
  }
}

/** console-style: extra arguments are mirrored to the console and forwarded
    as the structured detail (single value, or an array when several). */
export function logInfo(message: string, ...rest: unknown[]): void {
  console.info(message, ...rest);
  forward('info', message, rest);
}

export function logWarn(message: string, ...rest: unknown[]): void {
  console.warn(message, ...rest);
  forward('warn', message, rest);
}

export function logError(message: string, ...rest: unknown[]): void {
  console.error(message, ...rest);
  forward('error', message, rest);
}
