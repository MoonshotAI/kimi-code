import type { Logger } from 'pino';

export type RequestLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export function requestLog(req: { id: string }): RequestLogger | undefined {
  return (req as { log?: RequestLogger }).log;
}
