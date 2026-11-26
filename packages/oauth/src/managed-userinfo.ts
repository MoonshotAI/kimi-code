import { z } from 'zod';

import { fetchManagedJson, type ManagedEndpointFetchOptions } from './managed-fetch';
import { kimiCodeBaseUrl } from './managed-usage';
import { isRecord } from './utils';

export function kimiCodeUserInfoUrl(): string {
  return `${kimiCodeBaseUrl()}/me`;
}

export const managedUserInfoPhoneSchema = z.object({
  countryCode: z.string(),
  number: z.string(),
});
export type ManagedUserInfoPhone = z.infer<typeof managedUserInfoPhoneSchema>;

export const managedUserInfoSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  status: z.string(),
  region: z.string(),
  userLevel: z.number().int(),
  userLevelName: z.string(),
  domain: z.number().int(),
  domainName: z.string(),
  goodsVersion: z.number().int().optional(),
  globalId: z.string().optional(),
  bio: z.string().optional(),
  avatar: z.string().optional(),
  username: z.string().optional(),
  email: z.string().optional(),
  phone: managedUserInfoPhoneSchema.optional(),
  createdTime: z.string().optional(),
  lastLoginTime: z.string().optional(),
  workspaceName: z.string().optional(),
});
export type ManagedUserInfo = z.infer<typeof managedUserInfoSchema>;

const managedUserInfoOkSchema = z.object({
  kind: z.literal('ok'),
  userInfo: managedUserInfoSchema,
});

const managedUserInfoErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  status: z.number().int().optional(),
  errorCode: z.string().optional(),
});

export const managedUserInfoResultSchema = z.discriminatedUnion('kind', [
  managedUserInfoOkSchema,
  managedUserInfoErrorSchema,
]);
export type ManagedUserInfoResult = z.infer<typeof managedUserInfoResultSchema>;

export function parseManagedUserInfoPayload(payload: unknown): ManagedUserInfo | null {
  if (!isRecord(payload)) return null;
  const userId = stringField(payload, 'user_id');
  if (userId === undefined) return null;
  return {
    userId,
    nickname: stringField(payload, 'nickname') ?? '',
    status: stringField(payload, 'status') ?? '',
    region: stringField(payload, 'region') ?? '',
    userLevel: intField(payload, 'user_level') ?? 0,
    userLevelName: stringField(payload, 'user_level_name') ?? '',
    domain: intField(payload, 'domain') ?? 0,
    domainName: stringField(payload, 'domain_name') ?? '',
    goodsVersion: intField(payload, 'goods_version'),
    globalId: stringField(payload, 'global_id'),
    bio: stringField(payload, 'bio'),
    avatar: stringField(payload, 'avatar'),
    username: stringField(payload, 'username'),
    email: stringField(payload, 'email'),
    phone: parsePhone(payload['phone']),
    createdTime: stringField(payload, 'created_time'),
    lastLoginTime: stringField(payload, 'last_login_time'),
    workspaceName: stringField(payload, 'workspace_name'),
  };
}

function parsePhone(raw: unknown): ManagedUserInfoPhone | undefined {
  if (!isRecord(raw)) return undefined;
  const countryCode = stringField(raw, 'country_code') ?? '';
  const number = stringField(raw, 'number') ?? '';
  if (countryCode === '' && number === '') return undefined;
  return { countryCode, number };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function intField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

export interface FetchManagedUserInfoResult {
  readonly kind: 'ok';
  readonly userInfo: ManagedUserInfo;
}

export interface FetchManagedUserInfoError {
  readonly kind: 'error';
  readonly status?: number;
  readonly errorCode?: string;
  readonly message: string;
}

export async function fetchManagedUserInfo(
  url: string,
  accessToken: string,
  opts: ManagedEndpointFetchOptions = {},
): Promise<FetchManagedUserInfoResult | FetchManagedUserInfoError> {
  const response = await fetchManagedJson(url, accessToken, 'profile', {
    ...opts,
    status404Message: 'Profile endpoint not available. Try Kimi For Coding.',
  });
  if (response.kind === 'error') return response;
  const me = parseManagedUserInfoPayload(response.payload);
  if (me === null) {
    return { kind: 'error', message: 'Failed to fetch profile: malformed response.' };
  }
  return { kind: 'ok', userInfo: me };
}
