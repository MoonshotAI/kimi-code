import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  fetchManagedUserInfo,
  kimiCodeUserInfoUrl,
  managedUserInfoResultSchema,
  managedUserInfoSchema,
  parseManagedUserInfoPayload,
} from '../src/managed-userinfo';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('kimiCodeUserInfoUrl', () => {
  it('follows the KIMI_CODE_BASE_URL override', () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://gw.example.com/');
    expect(kimiCodeUserInfoUrl()).toBe('https://gw.example.com/me');
  });
});

describe('parseManagedUserInfoPayload', () => {
  it('returns null when the payload is not a record', () => {
    expect(parseManagedUserInfoPayload(null)).toBeNull();
    expect(parseManagedUserInfoPayload('nope')).toBeNull();
    expect(parseManagedUserInfoPayload([{ user_id: 'u_1' }])).toBeNull();
  });

  it('returns null when user_id is missing or not a string', () => {
    expect(parseManagedUserInfoPayload({ nickname: 'moonwalker' })).toBeNull();
    expect(parseManagedUserInfoPayload({ user_id: 42 })).toBeNull();
    expect(parseManagedUserInfoPayload({ user_id: '' })).toBeNull();
  });

  it('parses the full profile payload into the camelCase domain model', () => {
    const parsed = parseManagedUserInfoPayload({
      user_id: 'u_123',
      global_id: 'u_123',
      nickname: 'moonwalker',
      avatar: 'https://example.com/avatar.png',
      bio: 'to the moon',
      username: 'moonwalker2333',
      email: 'user@example.com',
      user_level: 30,
      user_level_name: 'Vivace',
      domain: 1,
      domain_name: 'DOMAIN_EXAMPLE',
      phone: { country_code: '86', number: '176****0000' },
      status: 'USER_STATUS_NORMAL',
      region: 'REGION_CN',
      created_time: '2026-06-11T13:26:47.561184Z',
      last_login_time: '2026-07-16T03:12:03.033412Z',
    });
    expect(parsed).toEqual({
      userId: 'u_123',
      globalId: 'u_123',
      nickname: 'moonwalker',
      avatar: 'https://example.com/avatar.png',
      bio: 'to the moon',
      username: 'moonwalker2333',
      email: 'user@example.com',
      userLevel: 30,
      userLevelName: 'Vivace',
      domain: 1,
      domainName: 'DOMAIN_EXAMPLE',
      phone: { countryCode: '86', number: '176****0000' },
      status: 'USER_STATUS_NORMAL',
      region: 'REGION_CN',
      createdTime: '2026-06-11T13:26:47.561184Z',
      lastLoginTime: '2026-07-16T03:12:03.033412Z',
    });
  });

  it('keeps only the required fields of a minimal payload', () => {
    const parsed = parseManagedUserInfoPayload({
      user_id: 'u_123',
      nickname: 'moonwalker',
      status: 'USER_STATUS_NORMAL',
      region: 'REGION_CN',
      user_level: 30,
      user_level_name: 'Vivace',
      domain: 1,
      domain_name: 'DOMAIN_EXAMPLE',
    });
    expect(parsed).toEqual({
      userId: 'u_123',
      nickname: 'moonwalker',
      status: 'USER_STATUS_NORMAL',
      region: 'REGION_CN',
      userLevel: 30,
      userLevelName: 'Vivace',
      domain: 1,
      domainName: 'DOMAIN_EXAMPLE',
      globalId: undefined,
      bio: undefined,
      avatar: undefined,
      username: undefined,
      email: undefined,
      phone: undefined,
      createdTime: undefined,
      lastLoginTime: undefined,
    });
  });

  it('degrades missing required fields to zero values', () => {
    const parsed = parseManagedUserInfoPayload({ user_id: 'u_123' });
    expect(parsed).toMatchObject({
      userId: 'u_123',
      nickname: '',
      status: '',
      region: '',
      userLevel: 0,
      userLevelName: '',
      domain: 0,
      domainName: '',
    });
  });

  it('drops a phone record whose fields are all empty or non-string', () => {
    expect(
      parseManagedUserInfoPayload({ user_id: 'u_1', phone: { country_code: 86 } })?.phone,
    ).toBeUndefined();
    expect(parseManagedUserInfoPayload({ user_id: 'u_1', phone: '86' })?.phone).toBeUndefined();
  });

  it('keeps a partially populated phone record', () => {
    const parsed = parseManagedUserInfoPayload({
      user_id: 'u_1',
      phone: { number: '176****0000' },
    });
    expect(parsed?.phone).toEqual({ countryCode: '', number: '176****0000' });
  });

  it('accepts numeric strings for the level fields and truncates fractions', () => {
    const parsed = parseManagedUserInfoPayload({
      user_id: 'u_1',
      user_level: '30',
      domain: 1.9,
    });
    expect(parsed).toMatchObject({ userLevel: 30, domain: 1 });
  });

  it('degrades non-numeric level fields to zero', () => {
    const parsed = parseManagedUserInfoPayload({
      user_id: 'u_1',
      user_level: 'thirty',
      domain: Number.NaN,
    });
    expect(parsed).toMatchObject({ userLevel: 0, domain: 0 });
  });

  it('keeps email only when it is a non-empty string', () => {
    expect(
      parseManagedUserInfoPayload({ user_id: 'u_1', email: 'user@example.com' })?.email,
    ).toBe('user@example.com');
    expect(parseManagedUserInfoPayload({ user_id: 'u_1', email: '' })?.email).toBeUndefined();
    expect(parseManagedUserInfoPayload({ user_id: 'u_1', email: 42 })?.email).toBeUndefined();
  });
});

describe('fetchManagedUserInfo', () => {
  it('sends only Authorization and Accept headers', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user_id: 'u_123',
            nickname: 'moonwalker',
            status: 'USER_STATUS_NORMAL',
            region: 'REGION_CN',
            user_level: 30,
            user_level_name: 'Vivace',
            domain: 1,
            domain_name: 'DOMAIN_EXAMPLE',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchManagedUserInfo('https://api.example/me', 'access-token')).resolves.toEqual({
      kind: 'ok',
      userInfo: {
        userId: 'u_123',
        nickname: 'moonwalker',
        status: 'USER_STATUS_NORMAL',
        region: 'REGION_CN',
        userLevel: 30,
        userLevelName: 'Vivace',
        domain: 1,
        domainName: 'DOMAIN_EXAMPLE',
        globalId: undefined,
        bio: undefined,
        avatar: undefined,
        username: undefined,
        email: undefined,
        phone: undefined,
        createdTime: undefined,
        lastLoginTime: undefined,
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
          new Response(JSON.stringify({ message: 'token expired' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchManagedUserInfo('https://api.example/me', 'access-token');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('token expired');
  });

  it('falls back to the local authorization hint on an empty 401 body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const result = await fetchManagedUserInfo('https://api.example/me', 'access-token');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('Authorization failed. Please check your API key (try /login).');
  });

  it('falls back to the local profile hint on an empty 404 body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    const result = await fetchManagedUserInfo('https://api.example/me', 'access-token');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(404);
    expect(result.message).toBe('Profile endpoint not available. Try Kimi For Coding.');
  });

  it('treats a payload without user_id as malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ nickname: 'moonwalker' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchManagedUserInfo('https://api.example/me', 'access-token');

    expect(result).toEqual({ kind: 'error', message: 'Failed to fetch profile: malformed response.' });
  });

  it('maps an aborted request to a timeout message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }),
    );

    const result = await fetchManagedUserInfo('https://api.example/me', 'access-token');

    expect(result).toEqual({
      kind: 'error',
      message: 'Failed to fetch profile: request timed out.',
    });
  });

  it('wraps network failures with the profile prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    const result = await fetchManagedUserInfo('https://api.example/me', 'access-token');

    expect(result).toEqual({ kind: 'error', message: 'Failed to fetch profile: socket hang up' });
  });
});

describe('managedUserInfoResultSchema', () => {
  const fullUserInfo = {
    userId: 'u_123',
    nickname: 'moonwalker',
    status: 'USER_STATUS_NORMAL',
    region: 'REGION_CN',
    userLevel: 30,
    userLevelName: 'Vivace',
    domain: 1,
    domainName: 'DOMAIN_EXAMPLE',
    globalId: 'u_123',
    avatar: 'https://example.com/avatar.png',
    username: 'moonwalker2333',
    email: 'user@example.com',
    phone: { countryCode: '86', number: '176****0000' },
    createdTime: '2026-06-11T13:26:47.561184Z',
    lastLoginTime: '2026-07-16T03:12:03.033412Z',
  };

  it('accepts a full camelCase domain payload', () => {
    expect(managedUserInfoResultSchema.parse({ kind: 'ok', userInfo: fullUserInfo })).toEqual({
      kind: 'ok',
      userInfo: fullUserInfo,
    });
    expect(
      managedUserInfoResultSchema.parse({ kind: 'error', message: 'nope', status: 401 }),
    ).toEqual({ kind: 'error', message: 'nope', status: 401 });
  });

  it('rejects a payload missing a required field', () => {
    expect(() =>
      managedUserInfoSchema.parse({
        userId: 'u_123',
        nickname: 'moonwalker',
        status: 'USER_STATUS_NORMAL',
        region: 'REGION_CN',
        userLevelName: 'Vivace',
        domain: 1,
        domainName: 'DOMAIN_EXAMPLE',
      }),
    ).toThrow();
  });

  it('strips unknown keys by default', () => {
    const parsed = managedUserInfoSchema.parse({
      ...fullUserInfo,
      unexpected_key: 'drop me',
    });
    expect(parsed).not.toHaveProperty('unexpected_key');
    expect(parsed).toEqual(fullUserInfo);
  });
});
