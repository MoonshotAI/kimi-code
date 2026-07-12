/**
 * acp-server diagnostic logger — writes structured lines to **stderr**.
 *
 * Stdout is the ACP JSON-RPC channel and must stay clean, so adapter
 * diagnostics go to stderr. Kept tiny (and dependency-free) on purpose; the
 * shape mirrors the `log.warn(msg, ctx)` call sites used throughout the
 * adapter.
 */

function write(level: string, msg: string, ctx?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, ...ctx });
  process.stderr.write(`${line}\n`);
}

export const log = {
  warn(msg: string, ctx?: Record<string, unknown>): void {
    write('warn', msg, ctx);
  },
  error(msg: string, ctx?: Record<string, unknown>): void {
    write('error', msg, ctx);
  },
  info(msg: string, ctx?: Record<string, unknown>): void {
    write('info', msg, ctx);
  },
};
