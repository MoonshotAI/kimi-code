import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedUserInfo, ManagedUserInfoResult } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useWorkspaceState } from '../src/client/useWorkspaceState';

const getKimiWebApiMock = vi.fn();

const profile: ManagedUserInfo = {
  userId: 'u_1',
  nickname: 'Kimi User',
  status: 'active',
  region: 'mainland-cn',
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
    managedMembership: null as 'member' | 'free' | null,
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
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
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

describe('checkAuth — managed membership', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('derives member when the profile loads', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    const { rawState, ws } = createWorkspaceState(getUserInfo);

    await ws.checkAuth();
    await flushUserInfo();

    expect(rawState.managedMembership).toBe('member');
  });

  it('derives free when the loaded profile reports the free user level', async () => {
    const getUserInfo = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', userInfo: { ...profile, userLevel: 10 } });
    const { rawState, ws } = createWorkspaceState(getUserInfo);

    await ws.checkAuth();
    await flushUserInfo();

    expect(rawState.managedMembership).toBe('free');
  });

  it('derives free when userinfo is rejected with 402 (the non-member signal)', async () => {
    const getUserInfo = vi
      .fn()
      .mockResolvedValue({ kind: 'error', message: 'payment required', status: 402 });
    const { rawState, ws } = createWorkspaceState(getUserInfo);

    await ws.checkAuth();
    await flushUserInfo();

    expect(rawState.managedMembership).toBe('free');
  });

  it.each([403, 500])(
    'stays unknown when userinfo fails with %i (not the non-member signal)',
    async (status) => {
      const getUserInfo = vi.fn().mockResolvedValue({ kind: 'error', message: 'boom', status });
      const { rawState, ws } = createWorkspaceState(getUserInfo);

      await ws.checkAuth();
      await flushUserInfo();

      expect(rawState.managedMembership).toBeNull();
    },
  );

  it('stays unknown when userinfo rejects (a transient failure must not be mislabeled)', async () => {
    const getUserInfo = vi.fn().mockRejectedValue(new Error('network down'));
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    rawState.managedMembership = 'free';

    await ws.checkAuth();
    await flushUserInfo();

    expect(rawState.managedMembership).toBeNull();
  });

  it('clears the membership when not authenticated', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    rawState.managedMembership = 'free';
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
    expect(rawState.managedMembership).toBeNull();
  });

  it('probeManagedMembership awaits the fetch and derives the membership', async () => {
    const deferreds: Array<{ resolve: (value: ManagedUserInfoResult) => void }> = [];
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve) => {
          deferreds.push({ resolve });
        }),
    );
    const { rawState, ws } = createWorkspaceState(getUserInfo);
    // Authenticate first (checkAuth fires its own fire-and-forget probe).
    await ws.checkAuth();

    let settled = false;
    const probe = ws.probeManagedMembership().then(() => {
      settled = true;
    });
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    await flushUserInfo();
    // The probe must not settle while its fetch is still in flight.
    expect(settled).toBe(false);

    deferreds[1]?.resolve({ kind: 'error', message: 'payment required', status: 402 });
    await probe;
    expect(settled).toBe(true);
    expect(rawState.managedMembership).toBe('free');
  });

  it('probeManagedMembership is a no-op when not authenticated', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    const { ws } = createWorkspaceState(getUserInfo);

    await ws.probeManagedMembership();

    expect(getUserInfo).not.toHaveBeenCalled();
  });
});
