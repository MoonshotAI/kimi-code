import { fetchManagedUserInfo, type ManagedUserInfo } from '@moonshot-ai/kimi-code-oauth';

import { currentKimiProfile } from '#/utils/region';

export interface BannerAudienceContext {
  login: 'logged_in' | 'anonymous' | 'unknown';
  userLevel?: number;
  goodsVersion?: number;
  accountRegion?: 'cn' | 'oversea';
}

/** The wire shape of a banner's `kfc_audience` targeting block. Every field
    is optional; absent means "no constraint on this dimension". The enums
    are the server contract — the meets* validators still reject out-of-contract
    values at runtime, since a mis-edited config can violate them at any time. */
export interface KfcAudience {
  login?: 'all' | 'logged_in' | 'anonymous' | null;
  tiers?: number[] | null;
  goods_version?: 1 | 2 | null;
  region?: 'all' | 'cn' | 'oversea' | null;
}

function normalizeEnumValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function meetsLogin(value: unknown, ctx: BannerAudienceContext): boolean {
  const login = normalizeEnumValue(value);
  if (login === null || login === 'all') return true;
  if (login === 'logged_in' || login === 'anonymous') return ctx.login === login;
  return false;
}

function parseTier(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function meetsTiers(value: unknown, ctx: BannerAudienceContext): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return true;
  const tiers = value.map(parseTier).filter((tier): tier is number => tier !== null);
  if (tiers.length === 0) return true;
  return ctx.userLevel !== undefined && tiers.includes(Math.trunc(ctx.userLevel));
}

function meetsGoodsVersion(value: unknown, ctx: BannerAudienceContext): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const version = Math.trunc(value);
  if (version !== 1 && version !== 2) return false;
  return ctx.goodsVersion === version;
}

function meetsRegion(value: unknown, ctx: BannerAudienceContext): boolean {
  const region = normalizeEnumValue(value);
  if (region === null || region === 'all') return true;
  if (region === 'cn' || region === 'oversea') return ctx.accountRegion === region;
  return false;
}

export function meetsBannerAudience(raw: unknown, ctx: BannerAudienceContext): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  const audience = raw as KfcAudience;
  return (
    meetsLogin(audience.login, ctx) &&
    meetsTiers(audience.tiers, ctx) &&
    meetsGoodsVersion(audience.goods_version, ctx) &&
    meetsRegion(audience.region, ctx)
  );
}

export type BannerUserInfoFetcher = (
  url: string,
  accessToken: string,
) => Promise<
  | { kind: 'ok'; userInfo: Pick<ManagedUserInfo, 'userLevel' | 'goodsVersion' | 'region'> }
  | { kind: 'error'; status?: number; message: string }
>;

export interface ResolveBannerAudienceOptions {
  fetchUserInfo?: BannerUserInfoFetcher;
  baseUrl?: string;
}

function bannerApiBaseUrl(): string {
  return (process.env['KIMI_CODE_BASE_URL'] ?? currentKimiProfile().baseUrl).replace(/\/+$/, '');
}

function mapAccountRegion(region: string): 'cn' | 'oversea' | undefined {
  const normalized = region.trim().toUpperCase();
  if (normalized === 'REGION_CN') return 'cn';
  if (normalized === 'REGION_OVERSEA') return 'oversea';
  return undefined;
}

export async function resolveBannerAudienceContext(
  accessToken: string | undefined,
  options: ResolveBannerAudienceOptions = {},
): Promise<BannerAudienceContext> {
  if (accessToken === undefined) return { login: 'anonymous' };
  const fetchUserInfo = options.fetchUserInfo ?? fetchManagedUserInfo;
  const baseUrl = (options.baseUrl ?? bannerApiBaseUrl()).replace(/\/+$/, '');
  let result: Awaited<ReturnType<BannerUserInfoFetcher>>;
  try {
    result = await fetchUserInfo(`${baseUrl}/me`, accessToken);
  } catch {
    return { login: 'unknown' };
  }
  if (result.kind === 'error') {
    const rejected = result.status === 401 || result.status === 402 || result.status === 403;
    return { login: rejected ? 'anonymous' : 'unknown' };
  }
  const { userLevel, goodsVersion, region } = result.userInfo;
  return { login: 'logged_in', userLevel, goodsVersion, accountRegion: mapAccountRegion(region) };
}
