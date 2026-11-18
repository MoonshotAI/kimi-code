import type { ISessionManager } from '@moonshot-ai/agent-core-v2';

import type { IConnectionRegistry } from '../transport/ws/connectionRegistry';
import { closeIdleSessions } from './sessionIdleReaper';

export const DEFAULT_MANAGED_IDLE_EXIT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;
const DRAIN_SWEEP_INTERVAL_MS = 2_000;

export class ManagedIdleExit {
  private timer: ReturnType<typeof setInterval> | undefined;
  private idleSince: number;
  private fired = false;
  private closed = false;
  private onDrained: (() => void) | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly sessions: Pick<ISessionManager, 'list' | 'closeIfIdle'>,
    private readonly connections: Pick<IConnectionRegistry, 'size'>,
    private readonly idleExitMs: number,
    private readonly onIdle: () => void,
    private readonly now: () => number = Date.now,
    private readonly sweepIntervalMs: number = SWEEP_INTERVAL_MS,
  ) {
    this.idleSince = now();
  }

  start(): void {
    if (this.timer !== undefined || this.closed) return;
    this.schedule(this.sweepIntervalMs);
  }

  exitWhenIdle(onExit: () => void): void {
    if (this.onDrained !== undefined || this.closed) return;
    this.onDrained = onExit;
    clearInterval(this.timer);
    this.schedule(DRAIN_SWEEP_INTERVAL_MS);
    void this.sweep();
  }

  sweep(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.sweepOnce();
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

  private schedule(intervalMs: number): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.timer.unref?.();
  }

  private async sweepOnce(): Promise<void> {
    if (this.fired || this.closed) return;
    const draining = this.onDrained !== undefined;
    if (!draining && this.connections.size() > 0) {
      this.idleSince = this.now();
      return;
    }
    await closeIdleSessions(this.sessions, 0);
    if (this.sessions.list().length > 0 || (!draining && this.connections.size() > 0)) {
      this.idleSince = this.now();
      return;
    }
    if (!draining && this.now() - this.idleSince < this.idleExitMs) return;
    this.fired = true;
    (this.onDrained ?? this.onIdle)();
  }
}
