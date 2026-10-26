import { writeUpdateCache } from './cache';
import { fetchChannelFeed, type ChannelFeed } from './cdn';
import { type UpdateCache, type UpdateChannel } from './types';

export interface RefreshUpdateCacheDeps {
  /** Resolves with the channel's latest version + manifest. **Throws** on any
   * failure — callers (including the default background invocation in
   * preflight) must catch. Errors intentionally skip `writeCache` so a
   * transient CDN blip does not overwrite a previously known `latest` with
   * `null`. */
  readonly fetchLatest: () => Promise<Omit<ChannelFeed, 'channel'>>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
  readonly channel: UpdateChannel;
  readonly timeoutMs?: number;
}

/** The cache just written, plus whether the canary pointer had to be skipped. */
export interface RefreshedUpdateCache extends UpdateCache {
  readonly degraded: boolean;
}

export async function refreshUpdateCache(
  overrides: Partial<RefreshUpdateCacheDeps> = {},
): Promise<RefreshedUpdateCache> {
  const channel = overrides.channel ?? 'stable';
  const resolved: RefreshUpdateCacheDeps = {
    fetchLatest:
      overrides.fetchLatest ?? (() => fetchChannelFeed(channel, undefined, overrides.timeoutMs)),
    writeCache: overrides.writeCache ?? writeUpdateCache,
    now: overrides.now ?? (() => new Date()),
    channel,
  };

  const { latest, manifest, degraded } = await resolved.fetchLatest();
  const cache: UpdateCache = {
    source: 'cdn',
    channel,
    checkedAt: resolved.now().toISOString(),
    latest,
    manifest,
  };
  await resolved.writeCache(cache);
  return { ...cache, degraded };
}
