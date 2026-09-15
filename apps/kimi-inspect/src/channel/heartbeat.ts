/**
 * Application-level heartbeat for the `/api/v3/ws` clients. The server has
 * no liveness probing of its own — it just answers `{type: 'ping'}` with a
 * `response` echoing the `request_id` — so each client pings on an interval
 * and tracks the reply itself:
 *
 *  - At most one ping is outstanding at a time; a reply is claimed through
 *    `consume(requestId)` (true when the response was the pending ping's).
 *  - Two consecutive intervals without the reply (`HEARTBEAT_MISS_LIMIT`)
 *    fire `onTimeout` exactly once (the timer stops) — the owner drops the
 *    socket, reconnects, and `start()`s again on the next `open`.
 *  - A timer gap of two intervals or more (throttled background tab, system
 *    sleep) is forgiven rather than counted: the outstanding ping is dropped
 *    and the next tick probes fresh instead of failing on stale clock math.
 */

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_MISS_LIMIT = 2;

export interface WsHeartbeatOptions {
  readonly intervalMs?: number;
  readonly sendPing: (requestId: string) => void;
  readonly onTimeout: () => void;
}

export class WsHeartbeat {
  private readonly intervalMs: number;
  private readonly sendPing: (requestId: string) => void;
  private readonly onTimeout: () => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  private pingRequestId: string | undefined;
  private misses = 0;
  private lastTickAt = 0;

  constructor(opts: WsHeartbeatOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.sendPing = opts.sendPing;
    this.onTimeout = opts.onTimeout;
  }

  start(): void {
    this.stop();
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.onTick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.pingRequestId = undefined;
    this.misses = 0;
  }

  consume(requestId: string): boolean {
    if (requestId !== this.pingRequestId) return false;
    this.pingRequestId = undefined;
    this.misses = 0;
    return true;
  }

  private onTick(): void {
    const now = Date.now();
    const suspended = now - this.lastTickAt >= this.intervalMs * 2;
    this.lastTickAt = now;
    if (suspended) {
      this.pingRequestId = undefined;
      this.misses = 0;
    }
    if (this.pingRequestId !== undefined) {
      this.misses += 1;
      if (this.misses >= HEARTBEAT_MISS_LIMIT) {
        this.stop();
        this.onTimeout();
      }
      return;
    }
    this.pingRequestId = crypto.randomUUID();
    this.sendPing(this.pingRequestId);
  }
}
