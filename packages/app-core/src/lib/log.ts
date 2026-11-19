
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
  } catch {}
}

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
