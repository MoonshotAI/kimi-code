import type { ISessionManager } from '@moonshot-ai/agent-core-v2';

import type { IConnectionRegistry } from '../transport/ws/connectionRegistry';
import { PeriodicSweep } from './periodicSweep';
import { closeIdleSessions } from './sessionIdleReaper';

export const DEFAULT_MANAGED_IDLE_EXIT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;
const DRAIN_SWEEP_INTERVAL_MS = 2_000;

export class ManagedIdleExit extends PeriodicSweep {
  private idleSince: number;
  private fired = false;
  private onDrained: (() => void) | undefined;

  constructor(
    private readonly sessions: Pick<ISessionManager, 'list' | 'closeIfIdle'>,
    private readonly connections: Pick<IConnectionRegistry, 'size'>,
    private readonly idleExitMs: number,
    private readonly onIdle: () => void,
    private readonly now: () => number = Date.now,
    private readonly sweepIntervalMs: number = SWEEP_INTERVAL_MS,
  ) {
    super();
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

  protected async sweepOnce(): Promise<void> {
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
