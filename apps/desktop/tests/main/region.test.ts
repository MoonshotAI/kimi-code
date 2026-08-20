import { beforeEach, describe, it, expect, vi } from 'vitest';

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
}));

// region.ts only touches electron for `net.fetch` inside the refresh; the
// tests drive that mock directly.
vi.mock('electron', () => ({
  net: { fetch: netFetchMock },
}));
vi.mock('../../src/main/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  parseServerRegionEnvelope,
  serverRegionProfile,
} from '../../src/main/region';

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'req_t' }));
}

describe('parseServerRegionEnvelope', () => {
  it('accepts the cn / global envelope', () => {
    expect(parseServerRegionEnvelope({ code: 0, msg: '', data: { region: 'mainland-cn' }, request_id: 'r' })).toBe('mainland-cn');
    expect(parseServerRegionEnvelope({ code: 0, msg: '', data: { region: 'global' }, request_id: 'r' })).toBe('global');
  });

  it('rejects malformed payloads', () => {
    expect(parseServerRegionEnvelope(null)).toBeNull();
    expect(parseServerRegionEnvelope('global')).toBeNull();
    expect(parseServerRegionEnvelope({ code: 0 })).toBeNull();
    expect(parseServerRegionEnvelope({ data: null })).toBeNull();
    expect(parseServerRegionEnvelope({ data: { region: 'apac' } })).toBeNull();
    expect(parseServerRegionEnvelope({ data: { region: 42 } })).toBeNull();
  });
});

describe('serverRegionProfile', () => {
  it('maps regions to their CDN / site roots', () => {
    expect(serverRegionProfile('mainland-cn')).toEqual({
      cdnBase: 'https://code.kimi.com/kimi-code',
      siteBase: 'https://www.kimi.com',
    });
    expect(serverRegionProfile('global')).toEqual({
      cdnBase: 'https://code.kimi.ai/kimi-code',
      siteBase: 'https://www.kimi.ai',
    });
  });
});

describe('refreshServerRegion', () => {
  // The module caches region + source at module scope, so each test re-imports
  // a fresh module — no test may depend on state seeded by an earlier one.
  let regionModule: typeof import('../../src/main/region');

  beforeEach(async () => {
    vi.resetModules();
    netFetchMock.mockReset();
    regionModule = await import('../../src/main/region');
  });

  async function seedOverseas(): Promise<void> {
    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    regionModule.setServerRegionSource('http://127.0.0.1:12345', 'token_t');
    // setServerRegionSource fires a refresh itself; let it land.
    await vi.waitFor(() => expect(regionModule.getServerRegion()).toBe('global'));
    netFetchMock.mockClear();
  }

  it('keeps the cn default until a source resolves a region, then caches it', async () => {
    // No source recorded yet: refresh is a no-op and the default holds.
    expect(regionModule.getServerRegion()).toBe('mainland-cn');
    await expect(regionModule.refreshServerRegion()).resolves.toBe('mainland-cn');
    expect(netFetchMock).not.toHaveBeenCalled();

    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    regionModule.setServerRegionSource('http://127.0.0.1:12345', 'token_t');
    // setServerRegionSource fires a refresh itself; let it land.
    await vi.waitFor(() => expect(regionModule.getServerRegion()).toBe('global'));

    const [url, init] = netFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:12345/api/v1/oauth/region');
    expect(init.headers['Authorization']).toBe('Bearer token_t');
  });

  it('keeps the cached region on endpoint-missing, network, and payload failures', async () => {
    await seedOverseas();

    // 404 (older server without the endpoint)
    netFetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(regionModule.refreshServerRegion()).resolves.toBe('global');

    // network failure
    netFetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(regionModule.refreshServerRegion()).resolves.toBe('global');

    // 200 with a malformed payload
    netFetchMock.mockResolvedValueOnce(envelope({ region: 'apac' }));
    await expect(regionModule.refreshServerRegion()).resolves.toBe('global');

    expect(regionModule.getServerRegion()).toBe('global');
  });

  it('passes an abort signal with the refresh fetch', async () => {
    await seedOverseas();

    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    await expect(regionModule.refreshServerRegion()).resolves.toBe('global');
    const init = netFetchMock.mock.calls.at(-1)?.[1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('times out a hung fetch and keeps the cached region', async () => {
    await seedOverseas();

    // Never answers on its own; rejects when the refresh's abort signal fires,
    // mimicking what net.fetch does once the deadline hits.
    netFetchMock.mockImplementationOnce(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError')),
          );
        }),
    );
    await expect(regionModule.refreshServerRegion(50)).resolves.toBe('global');
    expect(regionModule.getServerRegion()).toBe('global');
  });

  it('drops a stale in-flight response when a newer refresh lands first', async () => {
    await seedOverseas();

    // Older refresh: hangs until released, then reports a stale 'mainland-cn'.
    let releaseStale!: (response: Response) => void;
    netFetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { releaseStale = resolve; }),
    );
    const staleRefresh = regionModule.refreshServerRegion();

    // Newer refresh answers first with the current region.
    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    await expect(regionModule.refreshServerRegion()).resolves.toBe('global');

    // The stale response lands last; it must not overwrite the newer value.
    releaseStale(envelope({ region: 'mainland-cn' }));
    await expect(staleRefresh).resolves.toBe('global');
    expect(regionModule.getServerRegion()).toBe('global');
  });
});

describe('whenServerRegionSource', () => {
  let regionModule: typeof import('../../src/main/region');

  beforeEach(async () => {
    vi.resetModules();
    netFetchMock.mockReset();
    regionModule = await import('../../src/main/region');
  });

  it('resolves immediately when a source is already recorded', async () => {
    regionModule.setServerRegionSource('http://127.0.0.1:12345');
    await expect(regionModule.whenServerRegionSource(10)).resolves.toBe(true);
  });

  it('resolves early once a source is recorded mid-wait', async () => {
    const waiting = regionModule.whenServerRegionSource(10_000);
    regionModule.setServerRegionSource('http://127.0.0.1:12345');
    await expect(waiting).resolves.toBe(true);
  });

  it('bounds the wait and falls through to the default when no source ever comes', async () => {
    const started = Date.now();
    await expect(regionModule.whenServerRegionSource(60)).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    await expect(regionModule.refreshServerRegion()).resolves.toBe('mainland-cn');
  });
});

describe('setServerRegionSource with credentialed origins', () => {
  let regionModule: typeof import('../../src/main/region');

  beforeEach(async () => {
    vi.resetModules();
    netFetchMock.mockReset();
    regionModule = await import('../../src/main/region');
  });

  it('splits URL userinfo into a Basic authorization header', async () => {
    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    regionModule.setServerRegionSource('https://user:pass@127.0.0.1:12345');
    await vi.waitFor(() => expect(regionModule.getServerRegion()).toBe('global'));

    const [url, init] = netFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://127.0.0.1:12345/api/v1/oauth/region');
    expect(init.headers['Authorization']).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('keeps a reverse-proxy path prefix on the sanitized origin', async () => {
    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    regionModule.setServerRegionSource('https://user:pass@127.0.0.1:12345/kimi');
    await vi.waitFor(() => expect(regionModule.getServerRegion()).toBe('global'));

    const [url, init] = netFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://127.0.0.1:12345/kimi/api/v1/oauth/region');
    expect(init.headers['Authorization']).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('prefers the bearer token over URL userinfo when both are present', async () => {
    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    regionModule.setServerRegionSource('https://user:pass@127.0.0.1:12345', 'token_t');
    await vi.waitFor(() => expect(regionModule.getServerRegion()).toBe('global'));

    const [, init] = netFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['Authorization']).toBe('Bearer token_t');
  });
});

describe('refreshServerRegion supersede semantics', () => {
  let regionModule: typeof import('../../src/main/region');

  beforeEach(async () => {
    vi.resetModules();
    netFetchMock.mockReset();
    regionModule = await import('../../src/main/region');
    regionModule.setServerRegionSource('http://127.0.0.1:12345');
    netFetchMock.mockClear();
  });

  it('defers a superseded caller to the newest refresh outcome', async () => {
    // Older refresh: hangs until released, then reports a stale 'mainland-cn'.
    let releaseStale!: (response: Response) => void;
    netFetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { releaseStale = resolve; }),
    );
    const stale = regionModule.refreshServerRegion();

    // Newer refresh answers first and writes the fresh region.
    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    await expect(regionModule.refreshServerRegion()).resolves.toBe('global');

    // The superseded caller resolves with the newest outcome — not its own
    // dropped response, and not the cache it started from.
    releaseStale(envelope({ region: 'mainland-cn' }));
    await expect(stale).resolves.toBe('global');
    expect(regionModule.getServerRegion()).toBe('global');
  });
});

describe('updateServerRegionToken', () => {
  let regionModule: typeof import('../../src/main/region');

  beforeEach(async () => {
    vi.resetModules();
    netFetchMock.mockReset();
    regionModule = await import('../../src/main/region');
  });

  it('re-authenticates the probe after the renderer collects a new token', async () => {
    // Recorded without a token at connect time (stale/absent local token).
    netFetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    regionModule.setServerRegionSource('http://127.0.0.1:12345');
    await vi.waitFor(() => expect(netFetchMock).toHaveBeenCalledTimes(1));

    netFetchMock.mockResolvedValueOnce(envelope({ region: 'global' }));
    regionModule.updateServerRegionToken('fresh-token');
    await vi.waitFor(() => expect(regionModule.getServerRegion()).toBe('global'));

    const [, init] = netFetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(init.headers['Authorization']).toBe('Bearer fresh-token');
  });

  it('is a no-op before any region source exists', () => {
    expect(() => regionModule.updateServerRegionToken('fresh-token')).not.toThrow();
    expect(netFetchMock).not.toHaveBeenCalled();
  });
});

describe('refreshServerRegion chained supersede', () => {
  let regionModule: typeof import('../../src/main/region');

  beforeEach(async () => {
    vi.resetModules();
    netFetchMock.mockReset();
    regionModule = await import('../../src/main/region');
    regionModule.setServerRegionSource('http://127.0.0.1:12345');
    netFetchMock.mockClear();
  });

  it('a chain of overlapping refreshes lands on the true newest outcome', async () => {
    // A and B hang; C answers 'global' first and wins the write.
    let releaseA!: (response: Response) => void;
    let releaseB!: (response: Response) => void;
    netFetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseA = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseB = resolve; }))
      .mockResolvedValueOnce(envelope({ region: 'global' }));
    const a = regionModule.refreshServerRegion();
    const b = regionModule.refreshServerRegion();
    await expect(regionModule.refreshServerRegion()).resolves.toBe('global');

    // B's write is suppressed by C; A defers through B's deferral and both
    // must land on C's outcome, not on a superseded run's stale read.
    releaseB(envelope({ region: 'mainland-cn' }));
    releaseA(envelope({ region: 'mainland-cn' }));
    await expect(b).resolves.toBe('global');
    await expect(a).resolves.toBe('global');
    expect(regionModule.getServerRegion()).toBe('global');
  });
});

describe('whenServerRegionSource unbounded wait', () => {
  let regionModule: typeof import('../../src/main/region');

  beforeEach(async () => {
    vi.resetModules();
    netFetchMock.mockReset();
    regionModule = await import('../../src/main/region');
  });

  it('Infinity waits without a timeout until the source lands', async () => {
    const waiting = regionModule.whenServerRegionSource(Infinity);
    // No timer is armed — nothing resolves until a source is recorded.
    regionModule.setServerRegionSource('http://127.0.0.1:12345');
    await expect(waiting).resolves.toBe(true);
  });
});
