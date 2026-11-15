import { describe, expect, it, vi } from 'vitest';

import {
  meetsBannerAudience,
  resolveBannerAudienceContext,
  type BannerAudienceContext,
  type BannerUserInfoFetcher,
} from '#/tui/banner/audience';

const loggedIn: BannerAudienceContext = {
  login: 'logged_in',
  userLevel: 27,
  goodsVersion: 1,
  accountRegion: 'cn',
};
const anonymous: BannerAudienceContext = { login: 'anonymous' };
const unknown: BannerAudienceContext = { login: 'unknown' };

describe('meetsBannerAudience', () => {
  it('matches everyone when kfc_audience is absent', () => {
    for (const ctx of [loggedIn, anonymous, unknown]) {
      expect(meetsBannerAudience(undefined, ctx)).toBe(true);
      expect(meetsBannerAudience(null, ctx)).toBe(true);
    }
  });

  it('rejects a malformed kfc_audience instead of guessing', () => {
    for (const ctx of [loggedIn, anonymous, unknown]) {
      expect(meetsBannerAudience('all', ctx)).toBe(false);
      expect(meetsBannerAudience(42, ctx)).toBe(false);
      expect(meetsBannerAudience([], ctx)).toBe(false);
    }
  });

  describe('login', () => {
    it('matches everyone when missing, empty, or all', () => {
      for (const login of [undefined, null, '', 'all']) {
        expect(meetsBannerAudience({ login }, loggedIn)).toBe(true);
        expect(meetsBannerAudience({ login }, anonymous)).toBe(true);
        expect(meetsBannerAudience({ login }, unknown)).toBe(true);
      }
    });

    it('matches logged_in only against a logged-in context', () => {
      expect(meetsBannerAudience({ login: 'logged_in' }, loggedIn)).toBe(true);
      expect(meetsBannerAudience({ login: 'logged_in' }, anonymous)).toBe(false);
      expect(meetsBannerAudience({ login: 'logged_in' }, unknown)).toBe(false);
    });

    it('matches anonymous only against an anonymous context', () => {
      expect(meetsBannerAudience({ login: 'anonymous' }, loggedIn)).toBe(false);
      expect(meetsBannerAudience({ login: 'anonymous' }, anonymous)).toBe(true);
      expect(meetsBannerAudience({ login: 'anonymous' }, unknown)).toBe(false);
    });

    it('rejects an unrecognized login value for everyone', () => {
      for (const ctx of [loggedIn, anonymous, unknown]) {
        expect(meetsBannerAudience({ login: 'vip' }, ctx)).toBe(false);
      }
    });
  });

  describe('tiers', () => {
    it('matches everyone when missing, empty, or not an array', () => {
      for (const tiers of [undefined, null, [], 'paid']) {
        expect(meetsBannerAudience({ tiers }, loggedIn)).toBe(true);
        expect(meetsBannerAudience({ tiers }, anonymous)).toBe(true);
      }
    });

    it('matches when the context user level is in the list', () => {
      expect(meetsBannerAudience({ tiers: [15, 27] }, loggedIn)).toBe(true);
      expect(meetsBannerAudience({ tiers: [15, 20] }, loggedIn)).toBe(false);
    });

    it('never matches a context without a user level', () => {
      expect(meetsBannerAudience({ tiers: [27] }, anonymous)).toBe(false);
      expect(meetsBannerAudience({ tiers: [27] }, unknown)).toBe(false);
    });

    it('ignores non-numeric entries', () => {
      expect(meetsBannerAudience({ tiers: ['x', 27] }, loggedIn)).toBe(true);
      expect(meetsBannerAudience({ tiers: ['x'] }, loggedIn)).toBe(true);
    });
  });

  describe('goods_version', () => {
    it('matches everyone when missing', () => {
      for (const ctx of [loggedIn, anonymous, unknown]) {
        expect(meetsBannerAudience({}, ctx)).toBe(true);
        expect(meetsBannerAudience({ goods_version: null }, ctx)).toBe(true);
      }
    });

    it('matches only the same goods version', () => {
      expect(meetsBannerAudience({ goods_version: 1 }, loggedIn)).toBe(true);
      expect(meetsBannerAudience({ goods_version: 2 }, loggedIn)).toBe(false);
    });

    it('never matches a context without a goods version', () => {
      expect(meetsBannerAudience({ goods_version: 1 }, anonymous)).toBe(false);
      expect(meetsBannerAudience({ goods_version: 1 }, unknown)).toBe(false);
    });

    it('rejects values outside 1 and 2 for everyone', () => {
      for (const ctx of [loggedIn, anonymous, unknown]) {
        expect(meetsBannerAudience({ goods_version: 3 }, ctx)).toBe(false);
        expect(meetsBannerAudience({ goods_version: '1' }, ctx)).toBe(false);
      }
    });
  });

  describe('region', () => {
    it('matches everyone when missing, empty, or all', () => {
      for (const region of [undefined, null, '', 'all']) {
        expect(meetsBannerAudience({ region }, loggedIn)).toBe(true);
        expect(meetsBannerAudience({ region }, anonymous)).toBe(true);
      }
    });

    it('matches only the same account region', () => {
      expect(meetsBannerAudience({ region: 'cn' }, loggedIn)).toBe(true);
      expect(meetsBannerAudience({ region: 'oversea' }, loggedIn)).toBe(false);
      expect(meetsBannerAudience({ region: 'oversea' }, { ...loggedIn, accountRegion: 'oversea' })).toBe(true);
    });

    it('normalizes case and surrounding whitespace', () => {
      expect(meetsBannerAudience({ region: ' CN ' }, loggedIn)).toBe(true);
    });

    it('never matches a context without an account region', () => {
      expect(meetsBannerAudience({ region: 'cn' }, anonymous)).toBe(false);
      expect(meetsBannerAudience({ region: 'cn' }, unknown)).toBe(false);
    });

    it('rejects an unrecognized region value for everyone', () => {
      for (const ctx of [loggedIn, anonymous, unknown]) {
        expect(meetsBannerAudience({ region: 'mars' }, ctx)).toBe(false);
      }
    });
  });

  it('requires every present constraint to match', () => {
    const audience = { login: 'logged_in', tiers: [27], goods_version: 1, region: 'cn' };
    expect(meetsBannerAudience(audience, loggedIn)).toBe(true);
    expect(meetsBannerAudience(audience, { ...loggedIn, userLevel: 10 })).toBe(false);
    expect(meetsBannerAudience(audience, { ...loggedIn, goodsVersion: 2 })).toBe(false);
    expect(meetsBannerAudience(audience, { ...loggedIn, accountRegion: 'oversea' })).toBe(false);
    expect(meetsBannerAudience(audience, anonymous)).toBe(false);
  });
});

describe('resolveBannerAudienceContext', () => {
  const fetcherReturning = (result: unknown): BannerUserInfoFetcher =>
    vi.fn().mockResolvedValue(result) as unknown as BannerUserInfoFetcher;

  it('returns anonymous without any request when there is no access token', async () => {
    const fetchUserInfo = vi.fn();
    const ctx = await resolveBannerAudienceContext(undefined, { fetchUserInfo });
    expect(ctx).toEqual({ login: 'anonymous' });
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  it('builds a logged-in context from the userinfo payload', async () => {
    const fetchUserInfo = fetcherReturning({
      kind: 'ok',
      userInfo: { userLevel: 27, goodsVersion: 1, region: 'REGION_CN' },
    });
    const ctx = await resolveBannerAudienceContext('token', { fetchUserInfo, baseUrl: 'https://example.com' });
    expect(ctx).toEqual({ login: 'logged_in', userLevel: 27, goodsVersion: 1, accountRegion: 'cn' });
  });

  it('requests the /me URL of the resolved base URL with the bearer token', async () => {
    const fetchUserInfo = fetcherReturning({
      kind: 'ok',
      userInfo: { userLevel: 10, region: 'REGION_CN' },
    });
    await resolveBannerAudienceContext('token', { fetchUserInfo, baseUrl: 'https://example.com/coding/v1/' });
    expect(fetchUserInfo).toHaveBeenCalledWith('https://example.com/coding/v1/me', 'token');
  });

  it('leaves the account region unset when the payload region is unrecognized', async () => {
    const fetchUserInfo = fetcherReturning({
      kind: 'ok',
      userInfo: { userLevel: 10, region: 'REGION_SOMEWHERE' },
    });
    const ctx = await resolveBannerAudienceContext('token', { fetchUserInfo, baseUrl: 'https://example.com' });
    expect(ctx).toEqual({ login: 'logged_in', userLevel: 10, goodsVersion: undefined, accountRegion: undefined });
  });

  it('maps REGION_OVERSEA to the oversea account region', async () => {
    const fetchUserInfo = fetcherReturning({
      kind: 'ok',
      userInfo: { userLevel: 10, region: 'REGION_OVERSEA' },
    });
    const ctx = await resolveBannerAudienceContext('token', { fetchUserInfo, baseUrl: 'https://example.com' });
    expect(ctx).toMatchObject({ login: 'logged_in', accountRegion: 'oversea' });
  });

  it('treats 401, 402, and 403 as anonymous', async () => {
    for (const status of [401, 402, 403]) {
      const fetchUserInfo = fetcherReturning({ kind: 'error', status, message: 'denied' });
      const ctx = await resolveBannerAudienceContext('token', { fetchUserInfo, baseUrl: 'https://example.com' });
      expect(ctx).toEqual({ login: 'anonymous' });
    }
  });

  it('treats other failures and a throwing fetcher as unknown', async () => {
    const cases: BannerUserInfoFetcher[] = [
      fetcherReturning({ kind: 'error', status: 500, message: 'boom' }),
      fetcherReturning({ kind: 'error', message: 'timeout' }),
      vi.fn().mockRejectedValue(new Error('network down')) as unknown as BannerUserInfoFetcher,
    ];
    for (const fetchUserInfo of cases) {
      const ctx = await resolveBannerAudienceContext('token', { fetchUserInfo, baseUrl: 'https://example.com' });
      expect(ctx).toEqual({ login: 'unknown' });
    }
  });
});
