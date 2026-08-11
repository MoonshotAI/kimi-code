import { describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../src/api/daemon/client';

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeApi() {
  return new DaemonKimiWebApi({
    origin: 'http://test.local',
    identity,
    projectorFactory: () => {
      throw new Error('projector not needed for REST-only tests');
    },
  });
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'req_t' }));
}

describe('DaemonKimiWebApi.getUserInfo', () => {
  it('GETs /oauth/userinfo and passes the camelCase profile through unmapped', async () => {
    const userInfo = {
      userId: 'u_1',
      nickname: 'Kimi User',
      status: 'active',
      region: 'cn',
      userLevel: 3,
      userLevelName: 'Vivace',
      domain: 1,
      domainName: 'DOMAIN_EXAMPLE',
      globalId: 'g_1',
      bio: 'hello',
      avatar: 'https://cdn.example/avatar.png',
      username: 'kimiuser',
      email: 'kimi@example.com',
      phone: { countryCode: '+86', number: '13800000000' },
      createdTime: '2026-01-01T00:00:00Z',
      lastLoginTime: '2026-07-01T00:00:00Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(envelope({ kind: 'ok', userInfo }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getUserInfo();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/oauth/userinfo');
    expect(init.method).toBe('GET');
    expect(result).toEqual({ kind: 'ok', userInfo });
  });

  it('passes the error shape through untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({
      kind: 'error',
      message: 'not signed in',
      status: 401,
    })));

    await expect(makeApi().getUserInfo()).resolves.toEqual({
      kind: 'error',
      message: 'not signed in',
      status: 401,
    });
  });

  it('passes a minimal profile through with absent optionals staying absent', async () => {
    const userInfo = {
      userId: 'u_1',
      nickname: 'n',
      status: 'active',
      region: 'cn',
      userLevel: 0,
      userLevelName: '',
      domain: 0,
      domainName: 'DOMAIN_EXAMPLE',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ kind: 'ok', userInfo })));

    const result = await makeApi().getUserInfo();

    expect(result).toEqual({ kind: 'ok', userInfo });
  });
});
