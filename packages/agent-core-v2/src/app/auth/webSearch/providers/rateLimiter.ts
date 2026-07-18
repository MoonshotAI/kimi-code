/**
 * `auth` domain — shared rate limiter for LangSearch API providers.
 *
 * Simple in-memory sliding-window limiter enforcing QPS / QPM / QPD. Best-effort:
 * does not coordinate across processes. Used by both the search and rerank
 * providers to avoid 429s within a single session.
 */

export type LangSearchTier = 'free' | 'tier1' | 'tier2' | 'tier3';

export interface TierLimit {
  readonly qps: number;
  readonly qpm: number;
  readonly qpd: number;
}

export const TIER_LIMITS: Record<LangSearchTier, TierLimit> = {
  free: { qps: 1, qpm: 60, qpd: 1000 },
  tier1: { qps: 5, qpm: 200, qpd: 2000 },
  tier2: { qps: 10, qpm: 500, qpd: 10000 },
  tier3: { qps: 30, qpm: 2000, qpd: 100000 },
};

export class RateLimiter {
  private readonly limit: TierLimit;
  private readonly tierLabel: string;
  private readonly secondWindow: number[] = [];
  private readonly minuteWindow: number[] = [];
  private readonly dayWindow: number[] = [];

  constructor(limit: TierLimit, tierLabel: string) {
    this.limit = limit;
    this.tierLabel = tierLabel;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const now = Date.now();
      this.prune(now);

      if (this.dayWindow.length >= this.limit.qpd) {
        throw new Error(
          `LangSearch daily quota exhausted (tier: ${this.tierLabel}). Try again tomorrow or upgrade your tier.`,
        );
      }
      if (this.minuteWindow.length >= this.limit.qpm) {
        await this.sleepUntil(this.minuteWindow[0]! + 60_000, signal);
        continue;
      }
      if (this.secondWindow.length >= this.limit.qps) {
        await this.sleepUntil(this.secondWindow[0]! + 1_000, signal);
        continue;
      }

      this.secondWindow.push(now);
      this.minuteWindow.push(now);
      this.dayWindow.push(now);
      return;
    }
  }

  private prune(now: number): void {
    const oneSecondAgo = now - 1_000;
    const oneMinuteAgo = now - 60_000;
    const oneDayAgo = now - 86_400_000;
    while (this.secondWindow.length > 0 && this.secondWindow[0]! <= oneSecondAgo) {
      this.secondWindow.shift();
    }
    while (this.minuteWindow.length > 0 && this.minuteWindow[0]! <= oneMinuteAgo) {
      this.minuteWindow.shift();
    }
    while (this.dayWindow.length > 0 && this.dayWindow[0]! <= oneDayAgo) {
      this.dayWindow.shift();
    }
  }

  private async sleepUntil(target: number, signal?: AbortSignal): Promise<void> {
    const delay = Math.max(0, target - Date.now());
    if (delay <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
