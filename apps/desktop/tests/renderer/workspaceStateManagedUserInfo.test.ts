import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedUserInfo, ManagedUserInfoResult } from '../../src/renderer/api/types';

const { getKimiWebApiMock, trackMock } = vi.hoisted(() => ({
  getKimiWebApiMock: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock('../../src/renderer/api', () => ({ getKimiWebApi: getKimiWebApiMock }));
vi.mock('../../src/renderer/lib/track', () => ({ track: trackMock }));

import { useWorkspaceState } from '../../src/renderer/composables/client/useWorkspaceState';

const profile: ManagedUserInfo = {
  userId: 'u_1',
  nickname: 'Kimi User',
  status: 'active',
  region: 'cn',
  userLevel: 3,
  userLevelName: 'Vivace',
  domain: 1,
  domainName: 'DOMAIN_EXAMPLE',
  avatar: 'https://cdn.example/avatar.png',
};

function createWorkspaceState(getUserInfo: () => Promise<ManagedUserInfoResult>) {
  const rawState = {
    authReady: false,
    defaultModel: null as string | null,
    managedProviderStatus: null as string | null,
    managedUserInfo: null as ManagedUserInfo | null,
  };
  getKimiWebApiMock.mockReturnValue({
    getAuth: vi.fn().mockResolvedValue({
      ready: true,
      defaultModel: 'kimi-code',
      managedProvider: { status: 'authenticated' },
    }),
    getUserInfo,
  });
  const deps = { connectIssue: ref<string | null>(null) };
  return {
    rawState,
    ws: useWorkspaceState(rawState as never, deps as never),
  };
}

// The getUserInfo chain is fire-and-forget; a macrotask boundary drains its
// microtasks (the .catch on a rejection settles one tick after .then).
function flushUserInfo(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('checkAuth — managed account profile', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
  });

  it('stores the profile after an authenticated checkAuth (fire-and-forget /oauth/userinfo)', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    const { rawState, ws } = createWorkspaceState(getUserInfo);

    await expect(ws.checkAuth()).resolves.toBe('proceed');
    await flushUserInfo();

    expect(getUserInfo).toHaveBeenCalledTimes(1);
    expect(rawState.managedUserInfo).toEqual(profile);
  });

  it('clears the profile when /oauth/userinfo answers the error shape', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'error', message: 'endpoint unavailable' });
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    rawState.managedUserInfo = profile;

    await ws.checkAuth();
    await flushUserInfo();

    expect(rawState.managedUserInfo).toBeNull();
  });

  it('clears the profile when /oauth/userinfo rejects (older daemon / transient failure)', async () => {
    const getUserInfo = vi.fn().mockRejectedValue(new Error('404'));
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    rawState.managedUserInfo = profile;

    await ws.checkAuth();
    await flushUserInfo();

    expect(rawState.managedUserInfo).toBeNull();
  });

  it('does not resurrect the profile when a logout lands while /oauth/userinfo is in flight', async () => {
    let resolveUserInfo!: (value: ManagedUserInfoResult) => void;
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((done) => {
          resolveUserInfo = done;
        }),
    );
    const { rawState, ws } = createWorkspaceState(getUserInfo);

    await ws.checkAuth();
    // Logout's own checkAuth flips the status before the profile lands.
    rawState.managedProviderStatus = null;
    rawState.managedUserInfo = null;
    resolveUserInfo({ kind: 'ok', userInfo: profile });
    await flushUserInfo();

    expect(rawState.managedUserInfo).toBeNull();
  });

  it('skips /oauth/userinfo and clears the profile when not authenticated', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    rawState.managedUserInfo = profile;
    getKimiWebApiMock.mockReturnValue({
      getAuth: vi.fn().mockResolvedValue({
        ready: true,
        defaultModel: 'kimi-code',
        managedProvider: null,
      }),
      getUserInfo,
    });

    await ws.checkAuth();
    await flushUserInfo();

    expect(getUserInfo).not.toHaveBeenCalled();
    expect(rawState.managedUserInfo).toBeNull();
  });

  it('lets the newest request win when overlapping checkAuth profile fetches race', async () => {
    const deferreds: Array<{
      resolve: (value: ManagedUserInfoResult) => void;
      reject: (err: Error) => void;
    }> = [];
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        }),
    );
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    const newestProfile = { ...profile, nickname: 'Newest' };

    await ws.checkAuth();
    await ws.checkAuth();
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    const [stale, newest] = deferreds;
    if (!stale || !newest) throw new Error('expected two in-flight requests');

    // The newer request settles first and stores its profile…
    newest.resolve({ kind: 'ok', userInfo: newestProfile });
    await flushUserInfo();
    expect(rawState.managedUserInfo).toEqual(newestProfile);

    // …and the superseded request's late answer must not overwrite it.
    stale.resolve({ kind: 'ok', userInfo: profile });
    await flushUserInfo();
    expect(rawState.managedUserInfo).toEqual(newestProfile);
  });

  it('does not let a superseded rejection clear the profile written by the newest request', async () => {
    const deferreds: Array<{
      resolve: (value: ManagedUserInfoResult) => void;
      reject: (err: Error) => void;
    }> = [];
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        }),
    );
    const { rawState, ws } = createWorkspaceState(getUserInfo);

    await ws.checkAuth();
    await ws.checkAuth();
    const [stale, newest] = deferreds;
    if (!stale || !newest) throw new Error('expected two in-flight requests');

    newest.resolve({ kind: 'ok', userInfo: profile });
    await flushUserInfo();
    expect(rawState.managedUserInfo).toEqual(profile);

    stale.reject(new Error('404'));
    await flushUserInfo();
    expect(rawState.managedUserInfo).toEqual(profile);
  });

  it('lets the last-issued checkAuth win when the first call\'s /auth is slower', async () => {
    const authResponse = {
      ready: true,
      defaultModel: 'kimi-code',
      managedProvider: { status: 'authenticated' },
    };
    let resolveFirstAuth!: (value: typeof authResponse) => void;
    const getAuth = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof authResponse>((resolve) => {
            resolveFirstAuth = resolve;
          }),
      )
      .mockResolvedValue(authResponse);
    const deferreds: Array<{
      resolve: (value: ManagedUserInfoResult) => void;
      reject: (err: Error) => void;
    }> = [];
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        }),
    );
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    getKimiWebApiMock.mockReturnValue({ getAuth, getUserInfo });
    const newestProfile = { ...profile, nickname: 'Newest' };

    // The first call's /auth is slower: the second call settles first and its
    // userinfo writes the profile.
    const first = ws.checkAuth();
    await expect(ws.checkAuth()).resolves.toBe('proceed');
    expect(getUserInfo).toHaveBeenCalledTimes(1);
    const [secondUserInfo] = deferreds;
    if (!secondUserInfo) throw new Error('expected an in-flight userinfo request');
    secondUserInfo.resolve({ kind: 'ok', userInfo: newestProfile });
    await flushUserInfo();
    expect(rawState.managedUserInfo).toEqual(newestProfile);

    // The slower first call's /auth finally lands; its superseded userinfo
    // rejection must not clear the newer profile.
    resolveFirstAuth(authResponse);
    await expect(first).resolves.toBe('proceed');
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    const [, firstUserInfo] = deferreds;
    if (!firstUserInfo) throw new Error('expected a second in-flight userinfo request');
    firstUserInfo.reject(new Error('404'));
    await flushUserInfo();
    expect(rawState.managedUserInfo).toEqual(newestProfile);
  });
});
