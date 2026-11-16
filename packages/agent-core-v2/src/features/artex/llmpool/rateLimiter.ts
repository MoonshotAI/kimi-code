export interface ArtexTokenBucketConfig {
  readonly rps?: number;
  readonly rpm?: number;
  readonly burst?: number;
}

interface BucketWindow {
  readonly capacity: number;
  readonly refillPerMs: number;
  tokens: number;
  lastRefillMs: number;
}

function createWindow(rate: number, windowMs: number, burst: number | undefined, nowMs: number): BucketWindow {
  const capacity = Math.max(1, burst ?? Math.max(1, rate));
  return {
    capacity,
    refillPerMs: rate / windowMs,
    tokens: capacity,
    lastRefillMs: nowMs,
  };
}

function refillWindow(window: BucketWindow, nowMs: number): void {
  if (nowMs <= window.lastRefillMs) return;
  const elapsed = nowMs - window.lastRefillMs;
  window.tokens = Math.min(window.capacity, window.tokens + elapsed * window.refillPerMs);
  window.lastRefillMs = nowMs;
}

function delayForOneTokenMs(window: BucketWindow): number {
  if (window.tokens >= 1) return 0;
  return Math.ceil((1 - window.tokens) / window.refillPerMs);
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ArtexTokenBucket {
  private readonly windows: BucketWindow[] = [];
  private readonly now: () => number;

  constructor(config: ArtexTokenBucketConfig, now: () => number = Date.now) {
    this.now = now;
    const nowMs = this.now();
    if (config.rps !== undefined && config.rps > 0) {
      this.windows.push(createWindow(config.rps, 1_000, config.burst, nowMs));
    }
    if (config.rpm !== undefined && config.rpm > 0) {
      this.windows.push(createWindow(config.rpm, 60_000, config.burst, nowMs));
    }
  }

  tryAcquire(): boolean {
    return this.tryConsumeOrDelayMs() <= 0;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.windows.length === 0) {
      signal?.throwIfAborted();
      return;
    }
    for (;;) {
      signal?.throwIfAborted();
      const waitMs = this.tryConsumeOrDelayMs();
      if (waitMs <= 0) return;
      await delayWithAbort(waitMs, signal);
    }
  }

  private tryConsumeOrDelayMs(): number {
    if (this.windows.length === 0) return 0;
    const nowMs = this.now();
    let maxDelayMs = 0;
    for (const window of this.windows) {
      refillWindow(window, nowMs);
      const wait = delayForOneTokenMs(window);
      if (wait > maxDelayMs) {
        maxDelayMs = wait;
      }
    }
    if (maxDelayMs > 0) {
      return maxDelayMs;
    }
    for (const window of this.windows) {
      window.tokens -= 1;
    }
    return 0;
  }
}
