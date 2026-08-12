import { describe, expect, it, vi } from 'vitest';

import { OAuthTokenTransaction } from '../src/oauth-token-transaction';

interface TestTokens {
  access_token: string;
  refresh_token?: string;
}

describe('OAuthTokenTransaction', () => {
  it('coalesces concurrent rotating refresh-token grants', async () => {
    let stored: TestTokens | undefined = tokens('access-0', 'refresh-0');
    const first = transaction('same-server', () => stored, (value) => (stored = value));
    const second = transaction('same-server', () => stored, (value) => (stored = value));
    const tokenEndpoint = vi.fn<typeof fetch>(async () =>
      json(tokens('access-1', 'refresh-1')),
    );

    const [firstResult, secondResult] = await Promise.all([
      sdkRefresh(first, tokenEndpoint, 'refresh-0'),
      sdkRefresh(second, tokenEndpoint, 'refresh-0'),
    ]);

    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(tokens('access-1', 'refresh-1'));
    expect(secondResult).toEqual(tokens('access-1', 'refresh-1'));
    expect(stored).toEqual(tokens('access-1', 'refresh-1'));
  });

  it('does not let a late invalidation delete a newer winner', async () => {
    let stored: TestTokens | undefined = tokens('access-0', 'refresh-0');
    const rejected = transaction('same-server', () => stored, (value) => (stored = value));
    const peer = transaction('same-server', () => stored, (value) => (stored = value));
    const response = await rejected.createFetch(async () =>
      json({ error: 'invalid_grant' }, 400),
    )('https://issuer.example.test/token', refreshRequest('refresh-0'));

    expect(response.status).toBe(400);
    await peer.save(tokens('access-1', 'refresh-1'));
    await rejected.invalidateFromSdk('tokens');
    expect(stored).toEqual(tokens('access-1', 'refresh-1'));
  });

  it('preserves an access-only winner when an older refresh is queued', async () => {
    let stored: TestTokens | undefined = { access_token: 'access-from-login' };
    const stale = transaction('same-server', () => stored, (value) => (stored = value));
    const tokenEndpoint = vi.fn<typeof fetch>();

    const response = await stale.createFetch(tokenEndpoint)(
      'https://issuer.example.test/token',
      refreshRequest('stale-refresh'),
    );

    expect(response.status).toBe(400);
    expect(tokenEndpoint).not.toHaveBeenCalled();
    await stale.invalidateFromSdk('tokens');
    expect(stored).toEqual({ access_token: 'access-from-login' });
  });

  it('does not let a late save revive credentials after an explicit reset', async () => {
    let stored: TestTokens | undefined = tokens('access-0', 'refresh-0');
    const subject = transaction('same-server', () => stored, (value) => (stored = value));
    const response = await subject.createFetch(async () =>
      json(tokens('access-1', 'refresh-1')),
    )('https://issuer.example.test/token', refreshRequest('refresh-0'));
    const refreshed = parseTokens(await response.json());
    if (refreshed === undefined) throw new Error('invalid test token response');

    await subject.clear();
    await subject.save(refreshed);
    expect(stored).toBeUndefined();
  });

  it('does not delete durable tokens for an invalid authorization code', async () => {
    let stored: TestTokens | undefined = tokens('access-0', 'refresh-0');
    const subject = transaction('same-server', () => stored, (value) => (stored = value));
    const response = await subject.createFetch(async () =>
      json({ error: 'invalid_grant' }, 400),
    )('https://issuer.example.test/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'expired-code' }),
    });

    expect(response.status).toBe(400);
    await subject.invalidateFromSdk('tokens');
    expect(stored).toEqual(tokens('access-0', 'refresh-0'));
  });

  it('does not let a stale client error delete a newer authorization', async () => {
    let stored: TestTokens | undefined = tokens('access-0', 'refresh-0');
    const rejected = transaction('same-server', () => stored, (value) => (stored = value));
    const peer = transaction('same-server', () => stored, (value) => (stored = value));
    await rejected.createFetch(async () => json({ error: 'invalid_client' }, 400))(
      'https://issuer.example.test/token',
      {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'old-code' }),
      },
    );

    await peer.save(tokens('access-1', 'refresh-1'));
    await expect(rejected.invalidateFromSdk('all')).resolves.toBe(false);
    expect(stored).toEqual(tokens('access-1', 'refresh-1'));
  });

  it('ignores an SDK invalidation without a matching token request', async () => {
    let stored: TestTokens | undefined = tokens('access-0', 'refresh-0');
    const subject = transaction('same-server', () => stored, (value) => (stored = value));

    await expect(subject.invalidateFromSdk('tokens')).resolves.toBe(false);
    expect(stored).toEqual(tokens('access-0', 'refresh-0'));
  });
});

function transaction(
  key: string,
  read: () => TestTokens | undefined,
  write: (tokens: TestTokens | undefined) => void,
): OAuthTokenTransaction<TestTokens> {
  return new OAuthTokenTransaction({
    key,
    read: async () => read(),
    write: async (value) => {
      write(value);
    },
    remove: async () => {
      write(undefined);
    },
    parse: parseTokens,
  });
}

async function sdkRefresh(
  transaction: OAuthTokenTransaction<TestTokens>,
  fetchFn: typeof fetch,
  refreshToken: string,
): Promise<TestTokens> {
  const response = await transaction.createFetch(fetchFn)(
    'https://issuer.example.test/token',
    refreshRequest(refreshToken),
  );
  const payload = parseTokens(await response.json());
  if (payload === undefined) throw new Error('invalid test token response');
  const result = { refresh_token: refreshToken, ...payload };
  await transaction.save(result);
  return result;
}

function refreshRequest(refreshToken: string): RequestInit {
  return {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

function tokens(accessToken: string, refreshToken: string): TestTokens {
  return { access_token: accessToken, refresh_token: refreshToken };
}

function parseTokens(value: unknown): TestTokens | undefined {
  if (typeof value !== 'object' || value === null || !('access_token' in value)) return undefined;
  if (typeof value.access_token !== 'string') return undefined;
  const refreshToken = 'refresh_token' in value ? value.refresh_token : undefined;
  if (refreshToken !== undefined && typeof refreshToken !== 'string') return undefined;
  return { access_token: value.access_token, refresh_token: refreshToken };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
