/**
 * stdout-safe logging guard.
 *
 * ACP speaks JSON-RPC over stdout, so anything that leaks non-JSON bytes
 * onto stdout corrupts the channel. `console.log` / `console.info` /
 * `console.warn` all default to stdout in Node, which means a stray
 * debug print from any dependency can break the protocol.
 *
 * {@link redirectConsoleToStderr} rebinds those three sinks to stderr.
 * `console.error` is intentionally left alone because it already writes
 * to stderr and many third-party libraries rely on that.
 */

type ConsoleSink = (...args: unknown[]) => void;

interface SavedConsole {
  readonly log: ConsoleSink;
  readonly info: ConsoleSink;
  readonly warn: ConsoleSink;
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Redirect `console.log`, `console.info`, and `console.warn` to
 * `process.stderr` until the returned restore function is invoked.
 *
 * Returns a restore function that puts the original sinks back; calling
 * the restore function twice is harmless because it just reassigns
 * the saved references.
 */
export function redirectConsoleToStderr(): () => void {
  const saved: SavedConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };

  const writeStderr: ConsoleSink = (...args) => {
    process.stderr.write(`${args.map(formatArg).join(' ')}\n`);
  };

  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;

  return () => {
    console.log = saved.log;
    console.info = saved.info;
    console.warn = saved.warn;
  };
}
