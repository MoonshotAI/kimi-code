
import { net } from 'electron';

import { log } from '../diagnostics/log';

export type ServerRegion = 'mainland-cn' | 'global';

export const SERVER_REGION_PROFILES: Record<ServerRegion, { cdnBase: string; siteBase: string }> = {
  'mainland-cn': { cdnBase: 'https://code.kimi.com/kimi-code', siteBase: 'https://www.kimi.com' },
  global: { cdnBase: 'https://code.kimi.ai/kimi-code', siteBase: 'https://www.kimi.ai' },
};

let cachedRegion: ServerRegion = 'mainland-cn';

let regionSource: { origin: string; token?: string; basicAuth?: string } | null = null;

const REGION_FETCH_TIMEOUT_MS = 3_000;

let refreshSeq = 0;

let latestRefresh: { seq: number; promise: Promise<ServerRegion> } | null = null;

let sourceWaiters: Array<() => void> = [];

export function getServerRegion(): ServerRegion {
  return cachedRegion;
}

export function serverRegionProfile(region: ServerRegion = cachedRegion): { cdnBase: string; siteBase: string } {
  return SERVER_REGION_PROFILES[region];
}

export function setServerRegionSource(origin: string, token?: string): void {
  let sanitized = origin;
  let basicAuth: string | undefined;
  try {
    const url = new URL(origin);
    if (url.username !== '' || url.password !== '') {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      basicAuth = `Basic ${Buffer.from(credentials).toString('base64')}`;
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      sanitized = url.href.replace(/\/+$/, '');
    }
  } catch {}
  regionSource = { origin: sanitized, token, basicAuth };
  const waiters = sourceWaiters;
  sourceWaiters = [];
  for (const resolve of waiters) resolve();
  void refreshServerRegion();
}

export function updateServerRegionToken(token: string): void {
  if (regionSource === null) return;
  regionSource = { ...regionSource, token };
  void refreshServerRegion();
}

export function serverRequestTarget(): { baseUrl: string; authorization?: string } | null {
  if (regionSource === null) return null;
  const authorization = regionSource.token !== undefined
    ? `Bearer ${regionSource.token}`
    : regionSource.basicAuth;
  return authorization === undefined
    ? { baseUrl: regionSource.origin }
    : { baseUrl: regionSource.origin, authorization };
}

export function whenServerRegionSource(timeoutMs = 15_000): Promise<boolean> {
  if (regionSource !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    };
    const timer =
      timeoutMs === Infinity
        ? undefined
        : setTimeout(() => {
            sourceWaiters = sourceWaiters.filter((waiter) => waiter !== done);
            resolve(false);
          }, timeoutMs);
    timer?.unref();
    sourceWaiters.push(done);
  });
}

export function parseServerRegionEnvelope(body: unknown): ServerRegion | null {
  if (body === null || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return null;
  const region = (data as { region?: unknown }).region;
  return region === 'mainland-cn' || region === 'global' ? region : null;
}

export function refreshServerRegion(timeoutMs = REGION_FETCH_TIMEOUT_MS): Promise<ServerRegion> {
  const source = regionSource;
  const seq = ++refreshSeq;
  const run = (async (): Promise<ServerRegion> => {
    if (source !== null) {
      try {
        const headers: Record<string, string> = {};
        if (source.token !== undefined) {
          headers['Authorization'] = `Bearer ${source.token}`;
        } else if (source.basicAuth !== undefined) {
          headers['Authorization'] = source.basicAuth;
        }
        const response = await net.fetch(`${source.origin}/api/v1/oauth/region`, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          const region = parseServerRegionEnvelope(await response.json());
          if (region !== null && seq === refreshSeq && source === regionSource && region !== cachedRegion) {
            cachedRegion = region;
            log.info(`[kimi-desktop] server region resolved: ${region}`);
          }
        }
      } catch (error) {
        log.warn(`[kimi-desktop] server region refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return cachedRegion;
  })();
  const wrapped = (async (): Promise<ServerRegion> => {
    await run;
    if (latestRefresh !== null && latestRefresh.seq > seq) {
      return latestRefresh.promise;
    }
    return cachedRegion;
  })();
  latestRefresh = { seq, promise: wrapped };
  return wrapped;
}
