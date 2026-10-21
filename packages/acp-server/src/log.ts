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
