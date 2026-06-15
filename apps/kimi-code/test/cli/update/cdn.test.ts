import { describe, expect, it, vi } from 'vitest';

import { fetchLatestFromCdn, fetchLatestVersionFromCdn } from '#/cli/update/cdn';
import { KIMI_CODE_CDN_LATEST_JSON_URL, KIMI_CODE_CDN_LATEST_URL } from '#/constant/app';

function mockFetchOk(body: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  })) as unknown as typeof fetch;
}

function mockFetchStatus(status: number): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
  })) as unknown as typeof fetch;
}

type Route = { readonly status?: number; readonly body?: string } | Error;

/** URL-routed fetch mock: unrouted URLs return 404. */
function mockRoutedFetch(routes: Record<string, Route>): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const route = routes[String(input)];
    if (route === undefined) {
      return { ok: false, status: 404, text: async () => '' };
    }
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => route.body ?? '',
    };
  }) as unknown as typeof fetch;
}

const MANIFEST_BODY = JSON.stringify({
  schemaVersion: 1,
  version: '2.0.0',
  publishedAt: '2026-06-12T00:00:00.000Z',
  rollout: [
    { percent: 30, delaySeconds: 0 },
    { percent: 30, delaySeconds: 43_200 },
    { percent: 40, delaySeconds: 86_400 },
  ],
});

describe('fetchLatestVersionFromCdn', () => {
  it('returns the trimmed semver returned by CDN /latest', async () => {
    const f = mockFetchOk('  0.5.0\n');
    await expect(fetchLatestVersionFromCdn(f)).resolves.toBe('0.5.0');
    expect(f).toHaveBeenCalledWith(
      KIMI_CODE_CDN_LATEST_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('throws when response is non-2xx', async () => {
    await expect(fetchLatestVersionFromCdn(mockFetchStatus(404))).rejects.toThrow(/HTTP 404/);
  });

  it('throws when body is not valid semver', async () => {
    await expect(fetchLatestVersionFromCdn(mockFetchOk('not-a-version'))).rejects.toThrow(
      /invalid semver/,
    );
  });

  it('throws when body is empty', async () => {
    await expect(fetchLatestVersionFromCdn(mockFetchOk('   '))).rejects.toThrow(/invalid semver/);
  });

  it('propagates the underlying fetch error', async () => {
    const f = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(fetchLatestVersionFromCdn(f)).rejects.toThrow(/network down/);
  });
});

describe('fetchLatestFromCdn', () => {
  it('parses latest.json and returns the manifest', async () => {
    const f = mockRoutedFetch({ [KIMI_CODE_CDN_LATEST_JSON_URL]: { body: MANIFEST_BODY } });
    await expect(fetchLatestFromCdn(f)).resolves.toEqual({
      latest: '2.0.0',
      manifest: {
        version: '2.0.0',
        publishedAt: '2026-06-12T00:00:00.000Z',
        rollout: [
          { percent: 30, delaySeconds: 0 },
          { percent: 30, delaySeconds: 43_200 },
          { percent: 40, delaySeconds: 86_400 },
        ],
      },
    });
    expect(f).toHaveBeenCalledWith(
      KIMI_CODE_CDN_LATEST_JSON_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown manifest fields (lenient parsing)', async () => {
    const body = JSON.stringify({
      schemaVersion: 99,
      version: '2.0.0',
      publishedAt: '2026-06-12T00:00:00.000Z',
      rollout: [],
      futureField: { nested: true },
    });
    const f = mockRoutedFetch({ [KIMI_CODE_CDN_LATEST_JSON_URL]: { body } });
    const result = await fetchLatestFromCdn(f);
    expect(result.manifest).toEqual({
      version: '2.0.0',
      publishedAt: '2026-06-12T00:00:00.000Z',
      rollout: [],
    });
  });

  it('defaults a missing rollout to an empty plan (fully rolled out)', async () => {
    const body = JSON.stringify({
      version: '2.0.0',
      publishedAt: '2026-06-12T00:00:00.000Z',
    });
    const f = mockRoutedFetch({ [KIMI_CODE_CDN_LATEST_JSON_URL]: { body } });
    const result = await fetchLatestFromCdn(f);
    expect(result.manifest?.rollout).toEqual([]);
  });

  const fallbackCases: ReadonlyArray<readonly [string, Route]> = [
    ['latest.json is missing (HTTP 404)', { status: 404 }],
    ['latest.json fetch throws', new Error('network down')],
    ['body is not valid JSON', { body: 'not json {' }],
    ['version is not semver', { body: JSON.stringify({ version: 'nope', publishedAt: '2026-06-12T00:00:00.000Z' }) }],
    ['publishedAt is unparseable', { body: JSON.stringify({ version: '2.0.0', publishedAt: 'garbage' }) }],
    ['a batch percent is out of range', {
      body: JSON.stringify({
        version: '2.0.0',
        publishedAt: '2026-06-12T00:00:00.000Z',
        rollout: [{ percent: 150, delaySeconds: 0 }],
      }),
    }],
    ['a batch delay is negative', {
      body: JSON.stringify({
        version: '2.0.0',
        publishedAt: '2026-06-12T00:00:00.000Z',
        rollout: [{ percent: 100, delaySeconds: -1 }],
      }),
    }],
  ];

  for (const [name, route] of fallbackCases) {
    it(`falls back to plain /latest when ${name}`, async () => {
      const f = mockRoutedFetch({
        [KIMI_CODE_CDN_LATEST_JSON_URL]: route,
        [KIMI_CODE_CDN_LATEST_URL]: { body: '1.9.0\n' },
      });
      await expect(fetchLatestFromCdn(f)).resolves.toEqual({
        latest: '1.9.0',
        manifest: null,
      });
    });
  }

  it('throws when both latest.json and plain /latest fail', async () => {
    const f = mockRoutedFetch({
      [KIMI_CODE_CDN_LATEST_JSON_URL]: { status: 500 },
      [KIMI_CODE_CDN_LATEST_URL]: { status: 500 },
    });
    await expect(fetchLatestFromCdn(f)).rejects.toThrow(/HTTP 500/);
  });

  it('propagates the plain /latest error when the fallback also breaks', async () => {
    const f = mockRoutedFetch({
      [KIMI_CODE_CDN_LATEST_JSON_URL]: new Error('json down'),
      [KIMI_CODE_CDN_LATEST_URL]: { body: 'not-a-version' },
    });
    await expect(fetchLatestFromCdn(f)).rejects.toThrow(/invalid semver/);
  });

  it('falls back to plain /latest when latest.json hangs past the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input) === KIMI_CODE_CDN_LATEST_JSON_URL) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            }, { once: true });
          });
        }
        if (String(input) === KIMI_CODE_CDN_LATEST_URL) {
          return { ok: true, status: 200, text: async () => '1.9.0\n' };
        }
        return { ok: false, status: 404, text: async () => '' };
      }) as unknown as typeof fetch;

      const result = fetchLatestFromCdn(f);
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(result).resolves.toEqual({
        latest: '1.9.0',
        manifest: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when plain /latest also hangs past the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async (_input: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        });
      }) as unknown as typeof fetch;

      const result = fetchLatestFromCdn(f);
      const expectation = expect(result).rejects.toThrow(/aborted/);
      await vi.advanceTimersByTimeAsync(6_000);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
