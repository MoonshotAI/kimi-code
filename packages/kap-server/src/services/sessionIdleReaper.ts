import { Error2, ErrorCodes, type ISessionManager } from '@moonshot-ai/agent-core-v2';

import { PeriodicSweep } from './periodicSweep';
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

export async function closeIdleSessions(
  sessions: Pick<ISessionManager, 'list' | 'closeIfIdle'>,
  idleTimeoutMs: number,
  onError?: (sessionId: string, error: unknown) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  for (const handle of sessions.list()) {
    if (shouldStop?.() === true) return;
    try {
      await sessions.closeIfIdle(handle.id, idleTimeoutMs);
    } catch (error) {
      if (onError === undefined) throw error;
      onError(handle.id, error);
    }
  }
}

export class SessionIdleReaper extends PeriodicSweep {
  constructor(
    private readonly sessions: Pick<ISessionManager, 'list' | 'closeIfIdle'>,
    private readonly logger: Pick<ServerLogger, 'info' | 'warn'>,
    private readonly idleTimeoutMs: number,
    private readonly sweepIntervalMs: number = SWEEP_INTERVAL_MS,
  ) {
    super();
  }

  start(): void {
    if (this.closed || this.idleTimeoutMs <= 0 || this.timer !== undefined) return;
    this.schedule(this.sweepIntervalMs);
    this.logger.info(
      { idleTimeoutMs: this.idleTimeoutMs, sweepIntervalMs: this.sweepIntervalMs },
      'session idle reclaim enabled',
    );
  }

  protected async sweepOnce(): Promise<void> {
    await closeIdleSessions(
      this.sessions,
      this.idleTimeoutMs,
      (sessionId, error) => {
        this.logger.warn(
          { sessionId, err: error instanceof Error ? error.message : String(error) },
          'session idle reclaim failed',
        );
      },
      () => this.closed,
    );
  }
}
