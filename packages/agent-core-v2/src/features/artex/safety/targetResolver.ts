import { lookup } from 'node:dns/promises';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';

export interface ArtexResolveResult {
  readonly ips: readonly string[];
  readonly resolvedAt: string;
}

/**
 * Resolves a hostname to its addresses for the target gate. Injectable so tests
 * can supply a deterministic resolver instead of real DNS.
 */
export interface IArtexTargetResolver {
  readonly _serviceBrand: undefined;
  readonly resolverName: string;
  lookup(host: string, signal?: AbortSignal): Promise<ArtexResolveResult>;
}

export const IArtexTargetResolver: ServiceIdentifier<IArtexTargetResolver> =
  createDecorator<IArtexTargetResolver>('artexTargetResolver');

const LOOKUP_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly result: ArtexResolveResult;
}

export class SystemArtexTargetResolver extends Disposable implements IArtexTargetResolver {
  declare readonly _serviceBrand: undefined;
  readonly resolverName = 'system';

  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ArtexResolveResult>>();

  async lookup(host: string, signal?: AbortSignal): Promise<ArtexResolveResult> {
    const key = host.trim().toLowerCase();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.result;

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const lookupPromise = this.resolveFresh(key, signal).then((result) => {
      this.cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
      this.inFlight.delete(key);
      return result;
    });
    this.inFlight.set(key, lookupPromise);
    return lookupPromise;
  }

  private async resolveFresh(host: string, signal?: AbortSignal): Promise<ArtexResolveResult> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const records = await Promise.race([
        lookup(host, { all: true }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error(`DNS lookup timed out for ${host}`)),
            { once: true },
          );
        }),
      ]);
      const ips = records.map((record) => record.address).filter((address) => address !== '');
      if (ips.length === 0) {
        throw new Error(`no addresses for ${host}`);
      }
      return { ips, resolvedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}