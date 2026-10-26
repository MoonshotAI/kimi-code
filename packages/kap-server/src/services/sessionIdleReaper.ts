import { Error2, ErrorCodes, type ISessionManager } from '@moonshot-ai/agent-core-v2';

import type { ServerLogger } from './pinoLoggerService';

export const SESSION_IDLE_RECLAIM_ENV = 'KIMI_CODE_SESSION_IDLE_RECLAIM_MS';
export const DEFAULT_SESSION_IDLE_RECLAIM_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;

export function resolveSessionIdleReclaimMs(env: NodeJS.ProcessEnv): number {
  const raw = env[SESSION_IDLE_RECLAIM_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_SESSION_IDLE_RECLAIM_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `${SESSION_IDLE_RECLAIM_ENV} must be a non-negative integer, got ${JSON.stringify(raw)}.`,
      { details: { value: raw } },
    );
  }
  return parsed;
}

export class SessionIdleReaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly sessions: Pick<ISessionManager, 'list' | 'closeIfIdle'>,
    private readonly logger: Pick<ServerLogger, 'info' | 'warn'>,
    private readonly idleTimeoutMs: number,
    private readonly sweepIntervalMs: number = SWEEP_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.closed || this.idleTimeoutMs <= 0 || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
    this.timer.unref?.();
    this.logger.info(
      { idleTimeoutMs: this.idleTimeoutMs, sweepIntervalMs: this.sweepIntervalMs },
      'session idle reclaim enabled',
    );
  }

  sweep(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.sweepSessions();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private async sweepSessions(): Promise<void> {
    for (const handle of this.sessions.list()) {
      if (this.closed) return;
      try {
        await this.sessions.closeIfIdle(handle.id, this.idleTimeoutMs);
      } catch (error) {
        this.logger.warn(
          { sessionId: handle.id, err: error instanceof Error ? error.message : String(error) },
          'session idle reclaim failed',
        );
      }
    }
  }
}
