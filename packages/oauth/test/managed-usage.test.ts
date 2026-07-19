import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  fetchManagedUsage,
  formatDuration,
  formatResetTime,
  isManagedKimiCode,
  isManagedKimiCodeBaseUrl,
  kimiCodeBaseUrl,
  kimiCodeUsageUrl,
  parseManagedUsagePayload,
} from '../src/managed-usage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('kimiCodeBaseUrl', () => {
  it('strips trailing slashes from the KIMI_CODE_BASE_URL override', () => {
    // The env value must be normalized at the source: provision persists it
    // verbatim while the model refresh rewrites it normalized, and the
    // deep-equal diff between the two shapes would fire a spurious
    // providers-changed event mid-login.
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://gw.example.com/');
    expect(kimiCodeBaseUrl()).toBe('https://gw.example.com');
    expect(kimiCodeUsageUrl()).toBe('https://gw.example.com/usages');
  });
});

describe('isManagedKimiCodeBaseUrl', () => {
  it('matches the default managed endpoint, with or without a trailing slash', () => {
    expect(isManagedKimiCodeBaseUrl('https://api.kimi.com/coding/v1')).toBe(true);
    expect(isManagedKimiCodeBaseUrl('https://api.kimi.com/coding/v1/')).toBe(true);
  });

  it('matches against the KIMI_CODE_BASE_URL override', () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://gw.example.com/coding/v1/');
    expect(isManagedKimiCodeBaseUrl('https://gw.example.com/coding/v1')).toBe(true);
    expect(isManagedKimiCodeBaseUrl('https://api.kimi.com/coding/v1')).toBe(false);
  });

  it('is case-insensitive on the origin but strict on the path', () => {
    expect(isManagedKimiCodeBaseUrl('https://API.KIMI.COM/coding/v1')).toBe(true);
    expect(isManagedKimiCodeBaseUrl('https://api.kimi.com/CODING/v1')).toBe(false);
  });

  it('rejects other paths on the managed host and other hosts entirely', () => {
    expect(isManagedKimiCodeBaseUrl('https://api.kimi.com/coding/v2')).toBe(false);
    expect(isManagedKimiCodeBaseUrl('https://api.kimi.com/v1')).toBe(false);
    expect(isManagedKimiCodeBaseUrl('https://gateway.example.com/coding/v1')).toBe(false);
    expect(isManagedKimiCodeBaseUrl('https://api.moonshot.cn/v1')).toBe(false);
  });

  it('rejects undefined and unparseable values', () => {
    expect(isManagedKimiCodeBaseUrl(undefined)).toBe(false);
    expect(isManagedKimiCodeBaseUrl('')).toBe(false);
    expect(isManagedKimiCodeBaseUrl('not a url')).toBe(false);
  });
});

describe('isManagedKimiCode', () => {
  it('matches only the kimi-code managed provider', () => {
    expect(isManagedKimiCode('managed:kimi-code')).toBe(true);
    expect(isManagedKimiCode('managed:moonshot-ai')).toBe(false);
    expect(isManagedKimiCode('openai')).toBe(false);
    expect(isManagedKimiCode('')).toBe(false);
    expect(isManagedKimiCode(null)).toBe(false);
    expect(isManagedKimiCode()).toBe(false);
  });
});

describe('parseManagedUsagePayload', () => {
  it('returns empty when payload is not an object', () => {
    expect(parseManagedUsagePayload(null)).toEqual({ summary: null, limits: [], extraUsage: null });
    expect(parseManagedUsagePayload('nope')).toEqual({ summary: null, limits: [], extraUsage: null });
  });

  it('extracts a summary from the `usage` object', () => {
    const parsed = parseManagedUsagePayload({
      usage: { used: 40, limit: 1000, name: 'Weekly limit' },
    });
    expect(parsed.summary).toEqual({
      label: 'Weekly limit',
      used: 40,
      limit: 1000,
    });
    expect(parsed.limits).toEqual([]);
  });

  it('falls back to remaining=limit-used when used is absent', () => {
    const parsed = parseManagedUsagePayload({ usage: { remaining: 200, limit: 1000 } });
    expect(parsed.summary).toEqual({ label: 'Weekly limit', used: 800, limit: 1000 });
  });

  it('labels limits from window duration when no name is given', () => {
    const parsed = parseManagedUsagePayload({
      limits: [
        { detail: { used: 1, limit: 100 }, window: { duration: 300, timeUnit: 'MINUTE' } },
        { detail: { used: 2, limit: 50 }, window: { duration: 24, timeUnit: 'HOUR' } },
      ],
    });
    expect(parsed.limits.map((l) => l.label)).toEqual(['5h limit', '24h limit']);
  });

  it('prefers explicit item.name over window duration label', () => {
    const parsed = parseManagedUsagePayload({
      limits: [
        {
          name: 'Daily cap',
          detail: { used: 5, limit: 100 },
          window: { duration: 1440, timeUnit: 'MINUTE' },
        },
      ],
    });
    expect(parsed.limits[0]!.label).toBe('Daily cap');
  });

  it('surfaces reset hints from resetAt timestamps', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const parsed = parseManagedUsagePayload({ usage: { used: 1, limit: 10, resetAt: future } });
    expect(parsed.summary?.resetHint).toMatch(/^resets in .+ \(at .+\)$/);
  });

  it('surfaces reset hints from relative reset_in seconds', () => {
    // Frozen so the supplied duration survives verbatim: the epoch and the
    // countdown must read the same clock, otherwise 120s renders as "1m".
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 21, 14, 0, 0));
    const parsed = parseManagedUsagePayload({
      usage: { used: 1, limit: 10, reset_in: 120 },
    });
    expect(parsed.summary?.resetHint).toBe('resets in 2m (at 14:02)');
  });

  // A frozen clock cannot catch the regression these two guard against: the
  // epoch and the countdown must come from a *single* read, so the failure only
  // appears once the clock ticks between them. Advance `Date.now` by 1ms per
  // call to reproduce that in a deterministic way.
  const tickingClock = (base: number): void => {
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => base + calls++);
  };

  it('keeps the supplied reset_in duration when the clock ticks mid-parse', () => {
    tickingClock(new Date(2026, 0, 21, 14, 0, 0).getTime());
    const parsed = parseManagedUsagePayload({
      usage: { used: 1, limit: 10, reset_in: 120 },
    });
    expect(parsed.summary?.resetHint).toBe('resets in 2m (at 14:02)');
  });

  it('keeps a one-second reset_in window from collapsing to "reset"', () => {
    tickingClock(new Date(2026, 0, 21, 14, 0, 0).getTime());
    const parsed = parseManagedUsagePayload({
      usage: { used: 1, limit: 10, reset_in: 1 },
    });
    expect(parsed.summary?.resetHint).toBe('resets in 1s (at 14:00)');
  });

  it('extracts extra usage from boosterWallet.balance', () => {
    const parsed = parseManagedUsagePayload({
      usage: { used: 40, limit: 1000, name: 'Weekly limit' },
      boosterWallet: {
        id: 'wallet_1',
        balance: {
          type: 'BOOSTER',
          amount: '20000000000',
          amountLeft: '10000000000',
          unit: 'UNIT_CURRENCY',
        },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { currency: 'USD', priceInCents: '20000' },
        monthlyUsed: { currency: 'USD', priceInCents: '5000' },
      },
    });
    expect(parsed.extraUsage).toEqual({
      balanceCents: 10000,
      totalCents: 20000,
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimitCents: 20000,
      monthlyUsedCents: 5000,
      currency: 'USD',
    });
  });

  it('treats missing amountLeft as zero balance', () => {
    const parsed = parseManagedUsagePayload({
      usage: { used: 1, limit: 10 },
      boosterWallet: { balance: { type: 'BOOSTER', amount: '20000000000' } },
    });
    expect(parsed.extraUsage).toMatchObject({ totalCents: 20000, balanceCents: 0 });
  });

  it('defaults monthly limit fields when absent', () => {
    const parsed = parseManagedUsagePayload({
      usage: { used: 1, limit: 10 },
      boosterWallet: {
        balance: { type: 'BOOSTER', amount: '20000000000', amountLeft: '20000000000' },
      },
    });
    expect(parsed.extraUsage).toEqual({
      balanceCents: 20000,
      totalCents: 20000,
      monthlyChargeLimitEnabled: false,
      monthlyChargeLimitCents: 0,
      monthlyUsedCents: 0,
      currency: 'USD',
    });
  });

  it('returns null extra usage when boosterWallet is missing or invalid', () => {
    expect(parseManagedUsagePayload({ usage: { used: 1, limit: 10 } }).extraUsage).toBeNull();
    expect(
      parseManagedUsagePayload({
        usage: { used: 1, limit: 10 },
        boosterWallet: { balance: { type: 'OTHER', amount: '100', amountLeft: '50' } },
      }).extraUsage,
    ).toBeNull();
    expect(
      parseManagedUsagePayload({
        usage: { used: 1, limit: 10 },
        boosterWallet: { balance: { type: 'BOOSTER', amount: '0', amountLeft: '0' } },
      }).extraUsage,
    ).toBeNull();
  });
});

describe('fetchManagedUsage', () => {
  it('sends only Authorization and Accept headers', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ usage: { used: 1, limit: 10 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchManagedUsage('https://api.example/usages', 'access-token')).resolves.toEqual({
      kind: 'ok',
      parsed: {
        summary: { label: 'Weekly limit', used: 1, limit: 10 },
        limits: [],
        extraUsage: null,
      },
    });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const init = calls[0]?.[1] ?? {};
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('x-msh-platform')).toBeNull();
  });

  it('surfaces JSON API error messages with status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'usage quota unavailable' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchManagedUsage('https://api.example/usages', 'access-token');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('usage quota unavailable');
  });

  it('surfaces nested JSON API error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'usage endpoint moved' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchManagedUsage('https://api.example/usages', 'access-token');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(404);
    expect(result.message).toBe('usage endpoint moved');
  });

  it('falls back to local usage hints when the API error body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    const result = await fetchManagedUsage('https://api.example/usages', 'access-token');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(404);
    expect(result.message).toBe('Usage endpoint not available. Try Kimi For Coding.');
  });
});

describe('formatDuration', () => {
  it('formats days/hours/minutes', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(86_400 + 7200 + 600)).toBe('1d 2h 10m');
  });
});

describe('formatResetTime', () => {
  it('returns "reset" for past timestamps', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    expect(formatResetTime(past)).toBe('reset');
  });

  // The clock is frozen for the boundary cases below so each one asserts an
  // exact string. Targets are built with the local-time `Date` constructor, so
  // the expectations hold in any timezone the suite runs under.
  const freezeAt = (local: Date): void => {
    vi.useFakeTimers();
    vi.setSystemTime(local);
  };

  it('returns "resets in X" plus a local clock time for future timestamps', () => {
    freezeAt(new Date(2026, 0, 21, 14, 0, 0));
    const future = new Date(2026, 0, 21, 15, 0, 0).toISOString();
    expect(formatResetTime(future)).toBe('resets in 1h (at 15:00)');
  });

  it('shows bare HH:MM when the reset lands on the same local day', () => {
    freezeAt(new Date(2026, 0, 21, 14, 0, 0));
    const target = new Date(2026, 0, 21, 14, 30, 0).toISOString();
    expect(formatResetTime(target)).toBe('resets in 30m (at 14:30)');
  });

  it('includes the local date when the reset lands on another day of the same year', () => {
    freezeAt(new Date(2026, 0, 21, 14, 0, 0));
    const target = new Date(2026, 0, 24, 9, 5, 0).toISOString();
    expect(formatResetTime(target)).toBe('resets in 2d 19h 5m (at 01-24 09:05)');
  });

  it('includes the local date when the reset crosses midnight into the next day', () => {
    freezeAt(new Date(2026, 0, 21, 23, 50, 0));
    const target = new Date(2026, 0, 22, 0, 20, 0).toISOString();
    expect(formatResetTime(target)).toBe('resets in 30m (at 01-22 00:20)');
  });

  it('includes the year when the reset lands in a different year', () => {
    freezeAt(new Date(2026, 11, 31, 23, 50, 0));
    const target = new Date(2027, 0, 1, 0, 20, 0).toISOString();
    expect(formatResetTime(target)).toBe('resets in 30m (at 2027-01-01 00:20)');
  });

  it('falls back when parsing fails', () => {
    expect(formatResetTime('not-a-date')).toBe('resets at not-a-date');
  });
});
