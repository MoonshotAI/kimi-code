import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  fetchManagedUsage,
  formatDuration,
  formatResetTime,
  isManagedKimiCode,
  parseManagedUsagePayload,
} from '../src/managed-usage';

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(parseManagedUsagePayload(null)).toEqual({ summary: null, limits: [] });
    expect(parseManagedUsagePayload('nope')).toEqual({ summary: null, limits: [] });
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
    expect(parsed.summary?.resetHint).toMatch(/resets in/);
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

  it('returns "resets in X" for future timestamps', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^resets in /);
  });

  it('falls back when parsing fails', () => {
    expect(formatResetTime('not-a-date')).toBe('resets at not-a-date');
  });
});
