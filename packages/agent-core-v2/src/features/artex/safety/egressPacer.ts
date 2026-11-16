import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { IConfigService } from '#/app/config/config';

import { resolveArtexNoiseProfile } from '#/features/artex/config/configSection';

/**
 * Paces ARTEX-mode egress (FetchURL) per host according to the configured noise
 * profile. Enforces per-host spacing, per-host in-flight cap, global in-flight cap,
 * jitter, and Retry-After backoff on 429/503 responses surfaced via pace outcome hooks.
 */
export interface IArtexEgressPacer {
  readonly _serviceBrand: undefined;
  pace(host: string, signal?: AbortSignal): Promise<void>;
  noteResponse(host: string, status: number, retryAfterSeconds?: number): void;
}

export const IArtexEgressPacer: ServiceIdentifier<IArtexEgressPacer> =
  createDecorator<IArtexEgressPacer>('artexEgressPacer');

const MAX_GLOBAL = 32;
const MAX_JITTER_MS = 250;

export class ArtexEgressPacer extends Disposable implements IArtexEgressPacer {
  declare readonly _serviceBrand: undefined;

  private readonly nextAllowed = new Map<string, number>();
  private readonly perHostInflight = new Map<string, number>();
  private globalInflight = 0;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
  }

  async pace(host: string, signal?: AbortSignal): Promise<void> {
    const profile = resolveArtexNoiseProfile(this.config);
    if (profile.name === 'off' || profile.rps <= 0) return;
    const minIntervalMs = Math.max(1, Math.trunc(1000 / profile.rps));
    const key = host.trim().toLowerCase();
    const maxPerHost = profile.maxPerHost;
    while ((this.perHostInflight.get(key) ?? 0) >= maxPerHost || this.globalInflight >= MAX_GLOBAL) {
      await delay(50, signal);
    }
    this.perHostInflight.set(key, (this.perHostInflight.get(key) ?? 0) + 1);
    this.globalInflight += 1;
    try {
      const now = Date.now();
      const earliest = this.nextAllowed.get(key) ?? 0;
      const start = Math.max(now, earliest);
      const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
      this.nextAllowed.set(key, start + minIntervalMs + jitter);
      const delayMs = start + jitter - now;
      if (delayMs > 0) await delay(delayMs, signal);
    } finally {
      this.perHostInflight.set(key, Math.max(0, (this.perHostInflight.get(key) ?? 1) - 1));
      this.globalInflight = Math.max(0, this.globalInflight - 1);
    }
  }

  noteResponse(host: string, status: number, retryAfterSeconds?: number): void {
    if (status !== 429 && status !== 503) return;
    const key = host.trim().toLowerCase();
    const backoffMs =
      retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 2_000;
    const until = Date.now() + backoffMs;
    const current = this.nextAllowed.get(key) ?? 0;
    if (until > current) this.nextAllowed.set(key, until);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}