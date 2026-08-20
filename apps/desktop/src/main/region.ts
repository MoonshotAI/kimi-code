// Server-region resolution for the main process.
//
// The daemon resolves the account region (env override → persisted login host
// → install-channel marker → default 'mainland-cn') and exposes it as
// `GET /api/v1/oauth/region`. Main-process surfaces that point at region-
// dependent hosts — the auto-update feed, the release-notes CDN root, and the
// Help-menu site links — follow the resolved region so a global account
// never gets pinned to the .com hosts (and vice versa).
//
// The region can change with login/logout, so the cached value is refreshed
// against the server: once when connect.ts learns the server origin, and
// again before every update check (updater.ts). There is deliberately no
// login-event hook — the main process has no such seam, and the check
// cadence (startup +10s, then 4h, plus every manual check) bounds staleness
// for a loopback GET that costs nothing. Every failure (older server without
// the endpoint, unreachable, malformed payload) keeps the previous cache,
// which starts at the historical default 'mainland-cn'.

import { net } from 'electron';

import { log } from './log';

export type ServerRegion = 'mainland-cn' | 'global';

/** Region profile: the CDN root (update feed + release notes) and the
    marketing/console site root per region. */
export const SERVER_REGION_PROFILES: Record<ServerRegion, { cdnBase: string; siteBase: string }> = {
  'mainland-cn': { cdnBase: 'https://code.kimi.com/kimi-code', siteBase: 'https://www.kimi.com' },
  global: { cdnBase: 'https://code.kimi.ai/kimi-code', siteBase: 'https://www.kimi.ai' },
};

let cachedRegion: ServerRegion = 'mainland-cn';

// Where to ask for the region: the server origin (+ auth for external modes —
// the bearer token for the dev flow, or basic-auth userinfo carried in
// KIMI_SERVER_URL, which a Request URL may not embed). Recorded by connect.ts
// once the server target is known; null until then.
let regionSource: { origin: string; token?: string; basicAuth?: string } | null = null;

// A loopback GET answers in milliseconds; a hung one (server half-dead) must
// not stall the refresh forever — the update check awaits it.
const REGION_FETCH_TIMEOUT_MS = 3_000;

// Monotonic refresh counter: setServerRegionSource, update checks, and the
// Help menu can all refresh concurrently, and each response used to write the
// cache unconditionally — a slow earlier request could land after a newer one
// and resurrect a stale region (login/logout in between). Only the latest
// request's response may write.
let refreshSeq = 0;

// The newest in-flight refresh. A caller superseded by a newer request skips
// its own write, but it must not return the stale cache it happened to
// compute over — it resolves with the newest refresh's outcome instead.
let latestRefresh: { seq: number; promise: Promise<ServerRegion> } | null = null;

// Callers (the updater) that must not run before the first region source is
// recorded wait on this instead of falling through to the default feed.
let sourceWaiters: Array<() => void> = [];

/** Latest cached region; 'mainland-cn' until a refresh succeeds. */
export function getServerRegion(): ServerRegion {
  return cachedRegion;
}

export function serverRegionProfile(region: ServerRegion = cachedRegion): { cdnBase: string; siteBase: string } {
  return SERVER_REGION_PROFILES[region];
}

/** Record where region refreshes go (called once the connect flow resolves
    the server origin) and kick off the first refresh. */
export function setServerRegionSource(origin: string, token?: string): void {
  // KIMI_SERVER_URL may carry basic-auth userinfo (connect.ts supports it),
  // and a Request built from a credentialed URL throws — split it into an
  // Authorization header and keep the sanitized origin for fetches.
  let sanitized = origin;
  let basicAuth: string | undefined;
  try {
    const url = new URL(origin);
    if (url.username !== '' || url.password !== '') {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      basicAuth = `Basic ${Buffer.from(credentials).toString('base64')}`;
      url.username = '';
      url.password = '';
      // Rebuild from the full URL, not url.origin: a reverse-proxied
      // KIMI_SERVER_URL may carry a path prefix (host/kimi) that the whole
      // API lives under (connect-target.ts preserves it deliberately).
      url.search = '';
      url.hash = '';
      sanitized = url.href.replace(/\/+$/, '');
    }
  } catch {
    // Not a parseable URL — pass it through and let the probe fail as before.
  }
  regionSource = { origin: sanitized, token, basicAuth };
  const waiters = sourceWaiters;
  sourceWaiters = [];
  for (const resolve of waiters) resolve();
  void refreshServerRegion();
}

/** Update the probe credential after the renderer collected a new server
    token (ServerAuthDialog): the region source was recorded with whatever
    readServerToken() had at connect time, which can be stale or absent on
    credential-protected external servers. No-op until a source exists. */
export function updateServerRegionToken(token: string): void {
  if (regionSource === null) return;
  regionSource = { ...regionSource, token };
  void refreshServerRegion();
}

/** Resolves once a region source has been recorded (immediately when one
    already is). A check that runs before this would only see the default
    region, so feed-dependent callers await it first — but never forever:
    when the server cannot come up at all (embedded start failure, invalid
    external config), the bound expires and callers proceed with the cached /
    baked-in default rather than blocking updates and Help links for good.
    Resolves true when a source exists at resolution, false on timeout. */
export function whenServerRegionSource(timeoutMs = 15_000): Promise<boolean> {
  if (regionSource !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    };
    // Infinity waits without a bound — for fire-and-forget follow-ups that
    // may safely wait for a late server as long as it takes.
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

/** Parse a `/oauth/region` envelope; null = not a usable region payload. */
export function parseServerRegionEnvelope(body: unknown): ServerRegion | null {
  if (body === null || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return null;
  const region = (data as { region?: unknown }).region;
  return region === 'mainland-cn' || region === 'global' ? region : null;
}

/** Re-resolve the region against the recorded source. Never throws; a failed
    refresh (including a timeout) keeps the previous cache. Only the newest
    in-flight request may write the cache — a stale response is dropped, and a
    caller superseded while waiting resolves with the newest refresh's outcome
    instead of the cache it started from. `timeoutMs` bounds the fetch for
    interaction-level callers (the Help menu) and tests. */
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
          // Re-validate next to the write: the await above can outlast a newer
          // refresh (or a source swap), and only the newest request may write.
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
    // A newer refresh started while mine was in flight: defer to its full
    // outcome — the stored promise itself defers further when an even newer
    // refresh exists, so a chain of overlapping calls lands on the true
    // newest result, never a superseded run's stale cache.
    if (latestRefresh !== null && latestRefresh.seq > seq) {
      return latestRefresh.promise;
    }
    return cachedRegion;
  })();
  latestRefresh = { seq, promise: wrapped };
  return wrapped;
}
