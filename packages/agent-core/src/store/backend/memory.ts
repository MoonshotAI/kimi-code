import type { Journal } from '../writer';

export function memoryJournal(logs: Map<string, string[]> = new Map()): Journal {
  return {
    names: async (prefix) => [...logs.keys()].filter((name) => name.startsWith(prefix)).sort(),
    async *lines(log) {
      yield* logs.get(log) ?? [];
    },
    append: async (log, _seq, line) => {
      const lines = logs.get(log);
      if (lines === undefined) logs.set(log, [line]);
      else lines.push(line);
    },
    close: async () => {},
  };
}
