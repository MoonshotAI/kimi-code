import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedUserInfo, ManagedUserInfoResult } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { authStore } from '../src/stores/auth';
import { modelsStore } from '../src/stores/models';

const getKimiWebApiMock = vi.fn();

const profile: ManagedUserInfo = {
  userId: 'u_1',
  nickname: 'Kimi User',
  status: 'active',
  region: 'mainland-cn',
  userLevel: 30,
  userLevelName: 'Vivace',
  domain: 1,
  domainName: 'DOMAIN_EXAMPLE',
  avatar: 'https://cdn.example/avatar.png',
};

const AUTHENTICATED = { modelsReady: true, providersCount: 1, managedProvider: { status: 'authenticated' } };
const ANONYMOUS = { modelsReady: true, providersCount: 1, managedProvider: null };

function flushUserInfo(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mockApi(getAuth: unknown, getUserInfo?: unknown): void {
  getKimiWebApiMock.mockReturnValue({
    getAuth,
    getUserInfo: getUserInfo ?? vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile }),
  });
}

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  authStore().resetAuth();
  authStore().connectIssue = null;
  modelsStore().setModelsReady(false);
  modelsStore().setDefaultModel(null);
});

afterEach(() => {
  resetKimiClientDeps();
});

describe('kimi.auth — checkAuth snapshot', () => {
  it('stores the managed status, marks authChecked, and transcribes modelsReady into kimi.models', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED));

    await expect(authStore().checkAuth()).resolves.toBe('proceed');

    const auth = authStore();
    expect(auth.managedProviderStatus).toBe('authenticated');
    expect(auth.signedIn).toBe(true);
    expect(auth.authChecked).toBe(true);
    expect(modelsStore().modelsReady).toBe(true);
    expect(modelsStore().defaultModel).toBeNull();
  });

  it('modelsReady:false transcribes too (the gate depends on the explicit false)', async () => {
    modelsStore().setModelsReady(true);
    mockApi(vi.fn().mockResolvedValue({ ...ANONYMOUS, modelsReady: false }));

    await authStore().checkAuth();

    expect(modelsStore().modelsReady).toBe(false);
  });

  it('stores the profile after an authenticated checkAuth (fire-and-forget /oauth/userinfo)', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), getUserInfo);

    await expect(authStore().checkAuth()).resolves.toBe('proceed');
    await flushUserInfo();

    expect(getUserInfo).toHaveBeenCalledTimes(1);
    expect(authStore().managedUserInfo).toEqual(profile);
  });

  it('clears the profile when /oauth/userinfo answers the error shape', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockResolvedValue({ kind: 'error', message: 'endpoint unavailable' }));
    authStore().managedUserInfo = profile;

    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedUserInfo).toBeNull();
  });

  it('clears the profile when /oauth/userinfo rejects (older daemon / transient failure)', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockRejectedValue(new Error('404')));
    authStore().managedUserInfo = profile;

    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedUserInfo).toBeNull();
  });

  it('skips /oauth/userinfo and clears the profile when not authenticated', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    mockApi(vi.fn().mockResolvedValue(ANONYMOUS), getUserInfo);
    authStore().managedUserInfo = profile;
    authStore().managedMembership = 'member';

    await authStore().checkAuth();
    await flushUserInfo();

    expect(getUserInfo).not.toHaveBeenCalled();
    expect(authStore().managedUserInfo).toBeNull();
    expect(authStore().managedMembership).toBeNull();
    expect(authStore().signedIn).toBe(false);
  });

  it('does not resurrect the profile when a logout lands while /oauth/userinfo is in flight', async () => {
    let resolveUserInfo!: (value: ManagedUserInfoResult) => void;
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((done) => {
          resolveUserInfo = done;
        }),
    );
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), getUserInfo);

    await authStore().checkAuth();
    authStore().managedProviderStatus = null;
    authStore().managedUserInfo = null;
    resolveUserInfo({ kind: 'ok', userInfo: profile });
    await flushUserInfo();

    expect(authStore().managedUserInfo).toBeNull();
  });

  it('does not discard the in-flight profile fetch when a later /auth fails transiently', async () => {
    let resolveUserInfo!: (value: ManagedUserInfoResult) => void;
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((done) => {
          resolveUserInfo = done;
        }),
    );
    let authCall = 0;
    const getAuth = vi.fn().mockImplementation(() => {
      authCall += 1;
      if (authCall === 1) return Promise.resolve(AUTHENTICATED);
      return Promise.reject(new Error('connection refused'));
    });
    mockApi(getAuth, getUserInfo);

    await expect(authStore().checkAuth()).resolves.toBe('proceed');
    await expect(authStore().checkAuth()).resolves.toBe('retry');
    resolveUserInfo({ kind: 'ok', userInfo: profile });
    await flushUserInfo();

    expect(authStore().managedUserInfo).toEqual(profile);
    expect(authStore().managedMembership).toBe('member');
  });

  it('lets the newest request win when overlapping profile fetches race', async () => {
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
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), getUserInfo);
    const newestProfile = { ...profile, nickname: 'Newest' };

    await authStore().checkAuth();
    await authStore().checkAuth();
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    const [stale, newest] = deferreds;
    if (!stale || !newest) throw new Error('expected two in-flight requests');

    newest.resolve({ kind: 'ok', userInfo: newestProfile });
    await flushUserInfo();
    expect(authStore().managedUserInfo).toEqual(newestProfile);

    stale.resolve({ kind: 'ok', userInfo: profile });
    await flushUserInfo();
    expect(authStore().managedUserInfo).toEqual(newestProfile);
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
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), getUserInfo);

    await authStore().checkAuth();
    await authStore().checkAuth();
    const [stale, newest] = deferreds;
    if (!stale || !newest) throw new Error('expected two in-flight requests');

    newest.resolve({ kind: 'ok', userInfo: profile });
    await flushUserInfo();
    expect(authStore().managedUserInfo).toEqual(profile);

    stale.reject(new Error('404'));
    await flushUserInfo();
    expect(authStore().managedUserInfo).toEqual(profile);
  });
});

describe('kimi.auth — membership derivation', () => {
  beforeEach(() => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED));
  });

  it('derives member when the profile loads', async () => {
    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedMembership).toBe('member');
    expect(authStore().isFree).toBe(false);
  });

  it('derives free when the loaded profile reports the free user level', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockResolvedValue({ kind: 'ok', userInfo: { ...profile, userLevel: 10 } }));

    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedMembership).toBe('free');
    expect(authStore().isFree).toBe(true);
  });

  it('derives free on the v2 plan when the level is at or below 15', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockResolvedValue({ kind: 'ok', userInfo: { ...profile, userLevel: 15, goodsVersion: 2 } }));

    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedMembership).toBe('free');
    expect(authStore().isFree).toBe(true);
  });

  it('derives member on the v2 plan when the level is above 15', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockResolvedValue({ kind: 'ok', userInfo: { ...profile, userLevel: 16, goodsVersion: 2 } }));

    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedMembership).toBe('member');
    expect(authStore().isFree).toBe(false);
  });

  it('derives free when userinfo is rejected with 402 (the non-member signal)', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockResolvedValue({ kind: 'error', message: 'payment required', status: 402 }));

    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedMembership).toBe('free');
  });

  it.each([403, 500])(
    'stays unknown when userinfo fails with %i (not the non-member signal)',
    async (status) => {
      mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockResolvedValue({ kind: 'error', message: 'boom', status }));

      await authStore().checkAuth();
      await flushUserInfo();

      expect(authStore().managedMembership).toBeNull();
    },
  );

  it('stays unknown when userinfo rejects (a transient failure must not be mislabeled)', async () => {
    authStore().managedMembership = 'free';
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), vi.fn().mockRejectedValue(new Error('network down')));

    await authStore().checkAuth();
    await flushUserInfo();

    expect(authStore().managedMembership).toBeNull();
  });

  it('probeMembership joins the in-flight profile fetch instead of refetching', async () => {
    const deferreds: Array<{ resolve: (value: ManagedUserInfoResult) => void }> = [];
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve) => {
          deferreds.push({ resolve });
        }),
    );
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), getUserInfo);
    authStore().managedMembership = 'member';
    await authStore().checkAuth();

    let settled = false;
    const probe = authStore().probeMembership().then(() => {
      settled = true;
    });
    expect(getUserInfo).toHaveBeenCalledTimes(1);
    await flushUserInfo();
    expect(settled).toBe(false);

    deferreds[0]?.resolve({ kind: 'error', message: 'payment required', status: 402 });
    await probe;
    expect(settled).toBe(true);
    expect(authStore().managedMembership).toBe('free');
  });

  it('probeMembership fetches fresh when no profile fetch is in flight', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED), getUserInfo);
    await authStore().checkAuth();
    await flushUserInfo();

    await authStore().probeMembership();

    expect(getUserInfo).toHaveBeenCalledTimes(2);
    expect(authStore().managedMembership).toBe('member');
  });

  it('probeMembership is a no-op when not authenticated', async () => {
    const getUserInfo = vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile });
    mockApi(vi.fn().mockResolvedValue(ANONYMOUS), getUserInfo);

    await authStore().probeMembership();

    expect(getUserInfo).not.toHaveBeenCalled();
  });
});

describe('kimi.auth — failure outcomes + connectIssue', () => {
  it.each([401, 40101])('returns server-auth-required on a %i rejection', async (code) => {
    mockApi(vi.fn().mockRejectedValue(new DaemonApiError({ code, msg: 'Unauthorized', requestId: 'req_1' })));

    await expect(authStore().checkAuth()).resolves.toBe('server-auth-required');
    expect(authStore().connectIssue).toBeNull();
    expect(authStore().authChecked).toBe(false);
  });

  it('returns retry and surfaces the reason on a transient failure', async () => {
    mockApi(vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(authStore().checkAuth()).resolves.toBe('retry');
    expect(authStore().connectIssue).toEqual({ kind: 'unknown', message: 'connection refused' });
    expect(authStore().authChecked).toBe(false);
  });

  it('clears connectIssue once a check gets through', async () => {
    authStore().connectIssue = { kind: 'unknown', message: 'connection refused' };
    mockApi(vi.fn().mockResolvedValue(ANONYMOUS));

    await authStore().checkAuth();

    expect(authStore().connectIssue).toBeNull();
  });
});

describe('kimi.auth — single-flight with trailing + epoch', () => {
  it('an explicit mid-flight call joins the trailing probe instead of sharing the stale flight', async () => {
    let resolveAuth!: (value: typeof ANONYMOUS) => void;
    const getAuth = vi.fn(
      () =>
        new Promise<typeof ANONYMOUS>((done) => {
          resolveAuth = done;
        }),
    );
    mockApi(getAuth);

    const first = authStore().checkAuth();
    const second = authStore().checkAuth();
    expect(getAuth).toHaveBeenCalledTimes(1);

    resolveAuth(ANONYMOUS);
    await expect(first).resolves.toBe('proceed');
    await vi.waitFor(() => expect(getAuth).toHaveBeenCalledTimes(2));
    resolveAuth(ANONYMOUS);
    await expect(second).resolves.toBe('proceed');
    await flushUserInfo();
    expect(getAuth).toHaveBeenCalledTimes(2);
  });

  it('re-flies once when a call arrives mid-flight (trailing edge)', async () => {
    let resolveFirst!: (value: typeof ANONYMOUS) => void;
    const getAuth = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof ANONYMOUS>((done) => {
            resolveFirst = done;
          }),
      )
      .mockResolvedValue(ANONYMOUS);
    mockApi(getAuth);

    const first = authStore().checkAuth();
    const shared = authStore().checkAuth();
    resolveFirst(ANONYMOUS);
    await expect(first).resolves.toBe('proceed');
    await expect(shared).resolves.toBe('proceed');
    expect(getAuth).toHaveBeenCalledTimes(2);
    await flushUserInfo();
    expect(getAuth).toHaveBeenCalledTimes(2);
  });

  it('markAuthDirty joins only an in-flight probe; with none it schedules nothing', async () => {
    const getAuth = vi.fn().mockResolvedValue(ANONYMOUS);
    mockApi(getAuth);

    authStore().markAuthDirty();
    await flushUserInfo();
    expect(getAuth).not.toHaveBeenCalled();

    let resolveFirst!: (value: typeof ANONYMOUS) => void;
    getAuth.mockImplementationOnce(
      () =>
        new Promise<typeof ANONYMOUS>((done) => {
          resolveFirst = done;
        }),
    );
    const first = authStore().checkAuth();
    authStore().markAuthDirty();
    resolveFirst(ANONYMOUS);
    await first;
    expect(getAuth).toHaveBeenCalledTimes(2);
  });

  it('discards a pre-resetAuth flight result — a logout can never be resurrected by a late /auth', async () => {
    let resolveAuth!: (value: typeof AUTHENTICATED) => void;
    const getAuth = vi.fn(
      () =>
        new Promise<typeof AUTHENTICATED>((done) => {
          resolveAuth = done;
        }),
    );
    mockApi(getAuth);

    const pending = authStore().checkAuth();
    authStore().resetAuth();
    resolveAuth(AUTHENTICATED);
    await expect(pending).resolves.toBe('retry');
    await flushUserInfo();

    const auth = authStore();
    expect(auth.managedProviderStatus).toBeNull();
    expect(auth.managedUserInfo).toBeNull();
    expect(auth.authChecked).toBe(false);
    expect(modelsStore().modelsReady).toBe(false);
  });

  it('a stale FAILURE writes neither the store nor the splash diagnostic (epoch covers the catch path)', async () => {
    let rejectAuth!: (err: Error) => void;
    const getAuth = vi.fn(
      () =>
        new Promise<typeof ANONYMOUS>((_done, reject) => {
          rejectAuth = reject;
        }),
    );
    mockApi(getAuth);

    const pending = authStore().checkAuth();
    authStore().resetAuth();
    rejectAuth(new Error('connection refused'));
    await expect(pending).resolves.toBe('retry');

    expect(authStore().connectIssue).toBeNull();
    expect(authStore().authChecked).toBe(false);
  });

  it('starts a NEW generation flight on the first checkAuth after resetAuth (no stale-flight join)', async () => {
    let resolveStale!: (value: typeof ANONYMOUS) => void;
    const getAuth = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof ANONYMOUS>((done) => {
            resolveStale = done;
          }),
      )
      .mockResolvedValue(ANONYMOUS);
    mockApi(getAuth);

    const staleFlight = authStore().checkAuth();
    authStore().resetAuth();
    const fresh = authStore().checkAuth();
    expect(getAuth).toHaveBeenCalledTimes(2);
    resolveStale(ANONYMOUS);
    await staleFlight;
    await expect(fresh).resolves.toBe('proceed');
    expect(authStore().authChecked).toBe(true);
  });

  it('resetAuth clears the managed trio + authChecked but keeps the model domain', async () => {
    mockApi(vi.fn().mockResolvedValue(AUTHENTICATED));
    await authStore().checkAuth();
    await flushUserInfo();
    modelsStore().setDefaultModel('openai/gpt-4o');
    modelsStore().setModels([{ id: 'openai/gpt-4o' } as never]);

    authStore().resetAuth();

    const auth = authStore();
    expect(auth.managedProviderStatus).toBeNull();
    expect(auth.managedUserInfo).toBeNull();
    expect(auth.managedMembership).toBeNull();
    expect(auth.authChecked).toBe(false);
    expect(modelsStore().defaultModel).toBe('openai/gpt-4o');
    expect(modelsStore().models).toHaveLength(1);
  });
});

describe('kimi.auth — enterprise workspaces and membership revocation', () => {
  it('keeps hasBusinessWorkspace false for pure personal accounts', async () => {
    getKimiWebApiMock.mockReturnValue({
      getAuth: vi.fn().mockResolvedValue(AUTHENTICATED),
      getUserInfo: vi.fn().mockResolvedValue({ kind: 'ok', userInfo: profile }),
      listManagedWorkspaces: vi.fn().mockResolvedValue({
        kind: 'ok',
        workspaces: [
          {
            kind: 'personal',
            key: 'personal',
            name: 'Personal',
            current: true,
            disabled: false,
            switchable: true,
            roles: ['ROLE_OWNER'],
          },
        ],
      }),
    });

    await authStore().checkAuth();
    await flushUserInfo();

    const auth = authStore();
    expect(auth.hasBusinessWorkspace).toBe(false);
    expect(auth.managedWorkspaces[0]?.name).toBe('Kimi User');
  });

  it('switches workspace, reports identity_switch telemetry, and reloads auth + models', async () => {
    const tracked: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const { setProductTracker } = await import('../src/contracts');
    const { setAuthHooks } = await import('../src/stores/auth');
    const reload = vi.fn().mockResolvedValue(undefined);
    setProductTracker({
      track: (event, payload) => {
        tracked.push({ event, payload });
      },
    });
    setAuthHooks({ reload });

    let inBusiness = false;
    const switchManagedWorkspace = vi.fn().mockImplementation(async () => {
      inBusiness = true;
      return {
        kind: 'ok',
        provider: 'managed:kimi-code',
        target: { kind: 'business', businessId: 'biz_42' },
      };
    });
    getKimiWebApiMock.mockReturnValue({
      getAuth: vi.fn().mockResolvedValue(AUTHENTICATED),
      getUserInfo: vi.fn().mockImplementation(async () => ({
        kind: 'ok',
        userInfo: inBusiness
          ? { ...profile, userLevelName: 'Premium', workspaceName: 'Acme Studio' }
          : profile,
      })),
      listManagedWorkspaces: vi.fn().mockImplementation(async () => ({
        kind: 'ok',
        workspaces: [
          {
            kind: 'personal',
            key: 'personal',
            name: 'Kimi User',
            current: !inBusiness,
            disabled: false,
            switchable: true,
            roles: ['ROLE_OWNER'],
          },
          {
            kind: 'business',
            key: 'business:biz_42',
            businessId: 'biz_42',
            name: 'Acme Studio',
            status: 'STATUS_ACTIVE',
            current: inBusiness,
            disabled: false,
            switchable: true,
            roles: ['ROLE_MEMBER'],
          },
        ],
      })),
      switchManagedWorkspace,
    });

    try {
      await authStore().checkAuth();
      await flushUserInfo();
      expect(authStore().hasBusinessWorkspace).toBe(true);
      expect(authStore().currentManagedWorkspace?.key).toBe('personal');

      const outcome = await authStore().switchManagedWorkspace(
        { kind: 'business', businessId: 'biz_42' },
        'Acme Studio',
      );
      expect(outcome).toEqual({ ok: true });
      expect(tracked).toEqual([
        {
          event: 'identity_switch',
          payload: {
            from_type: 'personal',
            to_type: 'enterprise',
            enterprise_id: 'biz_42',
          },
        },
      ]);
      expect(authStore().currentManagedWorkspace?.key).toBe('business:biz_42');
      expect(authStore().managedUserInfo?.userLevelName).toBe('Premium');
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      setProductTracker({ track: () => {} });
      setAuthHooks(null);
    }
  });

  it('signs out once and opens the membership-revoked modal when REASON_BUSINESS_MEMBER_REMOVED arrives', async () => {
    let loggedOut = false;
    const logout = vi.fn().mockImplementation(async () => {
      loggedOut = true;
      return { loggedOut: true };
    });
    getKimiWebApiMock.mockReturnValue({
      getAuth: vi.fn().mockImplementation(async () => (loggedOut ? ANONYMOUS : AUTHENTICATED)),
      getUserInfo: vi.fn().mockResolvedValue({
        kind: 'error',
        status: 401,
        errorCode: 'REASON_BUSINESS_MEMBER_REMOVED',
        message: 'Removed.',
      }),
      listManagedWorkspaces: vi.fn().mockResolvedValue({
        kind: 'error',
        status: 401,
        errorCode: 'REASON_BUSINESS_MEMBER_REMOVED',
        message: 'Removed.',
      }),
      logout,
    });

    await authStore().checkAuth();
    await flushUserInfo();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(authStore().businessMembershipRevokedOpen).toBe(true);
    expect(authStore().signedIn).toBe(false);

    await authStore().acknowledgeBusinessMembershipRevoked();
    expect(authStore().businessMembershipRevokedOpen).toBe(false);
  });

  it('does not let reloadManagedWorkspaces clobber an in-flight userInfo fetch', async () => {
    let resolveUserInfo!: (value: ManagedUserInfoResult) => void;
    const getUserInfo = vi.fn().mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve) => {
          resolveUserInfo = resolve;
        }),
    );
    const listManagedWorkspaces = vi.fn().mockResolvedValue({
      kind: 'ok',
      workspaces: [
        {
          kind: 'personal',
          key: 'personal',
          name: 'Personal',
          current: true,
          disabled: false,
          switchable: true,
          roles: ['ROLE_OWNER'],
        },
      ],
    });
    getKimiWebApiMock.mockReturnValue({
      getAuth: vi.fn().mockResolvedValue(AUTHENTICATED),
      getUserInfo,
      listManagedWorkspaces,
    });

    await authStore().checkAuth();
    await authStore().reloadManagedWorkspaces();
    resolveUserInfo({ kind: 'ok', userInfo: profile });
    await flushUserInfo();

    expect(authStore().managedUserInfo).toEqual(profile);
    expect(authStore().managedMembership).toBe('member');
  });

  it('waits for in-flight revocation logout before acknowledgeBusinessMembershipRevoked resolves', async () => {
    let resolveLogout!: (value: { loggedOut: boolean }) => void;
    let logoutSettled = false;
    const logout = vi.fn().mockImplementation(
      () =>
        new Promise<{ loggedOut: boolean }>((resolve) => {
          resolveLogout = (val) => {
            logoutSettled = true;
            resolve(val);
          };
        }),
    );
    getKimiWebApiMock.mockReturnValue({
      getAuth: vi.fn().mockResolvedValue(ANONYMOUS),
      getUserInfo: vi.fn().mockResolvedValue({ kind: 'error', status: 401, message: 'Unauthorized' }),
      logout,
    });

    void authStore().handleBusinessMembershipRevoked();
    expect(authStore().businessMembershipRevokedOpen).toBe(true);
    expect(authStore().signedIn).toBe(false);

    let ackResolved = false;
    const ackPromise = authStore().acknowledgeBusinessMembershipRevoked().then(() => {
      ackResolved = true;
    });
    await flushUserInfo();
    expect(ackResolved).toBe(false);

    resolveLogout({ loggedOut: true });
    await ackPromise;
    expect(logoutSettled).toBe(true);
    expect(ackResolved).toBe(true);
  });
});
