import type { LogEntry, LogWriter } from './log';

export const consoleLogWriter: LogWriter = {
  write(entry: LogEntry): void {
    const args: unknown[] = [entry.message];
    if (entry.context !== undefined) args.push(entry.context);
    if (entry.error !== undefined) args.push(entry.error);
    switch (entry.level) {
      case 'error':
        console.error(...args);
        break;
      case 'warn':
        console.warn(...args);
        break;
      case 'info':
        console.info(...args);
        break;
      case 'debug':
        console.debug(...args);
        break;
    }
  },
};

export interface MemoryLogWriter extends LogWriter {
  readonly entries: LogEntry[];
}

export function createMemoryLogWriter(): MemoryLogWriter {
  const entries: LogEntry[] = [];
  return {
    entries,
    write: (entry) => {
      entries.push(entry);
    },
  };
}
