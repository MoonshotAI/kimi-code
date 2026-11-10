import type { ISessionManager } from '@moonshot-ai/agent-core-v2';

import type { IConnectionRegistry } from '../transport/ws/connectionRegistry';

export const DEFAULT_MANAGED_IDLE_EXIT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

export class ManagedIdleExit {
  private timer: ReturnType<typeof setInterval> | undefined;
  private idleSince: number;
  private fired = false;

  constructor(
    private readonly sessions: Pick<ISessionManager, 'list'>,
    private readonly connections: Pick<IConnectionRegistry, 'size'>,
    private readonly idleExitMs: number,
    private readonly onIdle: () => void,
    private readonly now: () => number = Date.now,
    private readonly sweepIntervalMs: number = SWEEP_INTERVAL_MS,
  ) {
    this.idleSince = now();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  sweep(): void {
    if (this.fired) return;
    if (this.connections.size() > 0 || this.sessions.list().length > 0) {
      this.idleSince = this.now();
      return;
    }
    if (this.now() - this.idleSince < this.idleExitMs) return;
    this.fired = true;
    this.onIdle();
  }

  close(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
