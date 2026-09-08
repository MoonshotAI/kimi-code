/**
 * Managed-platform profile fetch / parse.
 *
 * Only `managed:kimi-code` is supported today. The platform exposes a
 * `/me` endpoint that returns a payload of the shape:
 *
 *   {
 *     "user_id": "u_123",
 *     "nickname": "moonwalker",
 *     "status": "USER_STATUS_NORMAL",
 *     "region": "REGION_CN",
 *     "user_level": 30,
 *     "user_level_name": "Vivace",
 *     "domain": 1,
 *     "domain_name": "DOMAIN_EXAMPLE",
 *     "global_id": "u_123",
 *     "avatar": "https://example.com/avatar.png",
 *     "email": "user@example.com",
 *     "phone": { "country_code": "86", "number": "176****0000" },
 *     "created_time": "2026-06-11T13:26:47.561184Z",
 *     "last_login_time": "2026-07-16T03:12:03.033412Z"
 *   }
 *
 * `user_id` / `nickname` / `status` / `region` / `user_level` /
 * `user_level_name` / `domain` / `domain_name` are always serialized
 * (possibly as zero values); the rest are optional (`phone` a nested
 * record, the timestamps RFC3339 strings passed through verbatim). The
 * parser normalizes the payload into a structured, camelCase domain
 * model; presentation is left to the consumer.
 *
 * The camelCase zod schemas below are the single source of truth for the
 * domain model and double as the daemon REST wire contract: new daemon
 * endpoints speak the camelCase domain shape directly, while legacy
 * snake_case endpoints are unaffected.
 */

import { z } from 'zod';

import { readApiErrorMessage } from './api-error';
import { kimiCodeBaseUrl } from './managed-usage';
import { isRecord } from './utils';

// The cloud path stays `/me` (owned by the backend); only the local
// naming moved to "userinfo".
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
  globalId: z.string().optional(),
  bio: z.string().optional(),
  avatar: z.string().optional(),
  username: z.string().optional(),
  email: z.string().optional(),
  phone: managedUserInfoPhoneSchema.optional(),
  /** Backend RFC3339 timestamp, passed through verbatim. */
  createdTime: z.string().optional(),
  /** Backend RFC3339 timestamp, passed through verbatim. */
  lastLoginTime: z.string().optional(),
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
});

export const managedUserInfoResultSchema = z.discriminatedUnion('kind', [
  managedUserInfoOkSchema,
  managedUserInfoErrorSchema,
]);
export type ManagedUserInfoResult = z.infer<typeof managedUserInfoResultSchema>;

/**
 * Lenient parse: anything that is not a record, or lacks a `user_id`
 * string, is malformed; every other field degrades independently.
 */
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
    globalId: stringField(payload, 'global_id'),
    bio: stringField(payload, 'bio'),
    avatar: stringField(payload, 'avatar'),
    username: stringField(payload, 'username'),
    email: stringField(payload, 'email'),
    phone: parsePhone(payload['phone']),
    createdTime: stringField(payload, 'created_time'),
    lastLoginTime: stringField(payload, 'last_login_time'),
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
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

// ── HTTP fetch ────────────────────────────────────────────────────────

export interface FetchManagedUserInfoResult {
  readonly kind: 'ok';
  readonly userInfo: ManagedUserInfo;
}

export interface FetchManagedUserInfoError {
  readonly kind: 'error';
  readonly status?: number;
  readonly message: string;
}

export async function fetchManagedUserInfo(
  url: string,
  accessToken: string,
  opts: { timeoutMs?: number } = {},
): Promise<FetchManagedUserInfoResult | FetchManagedUserInfoError> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const status = res.status;
      const hint =
        status === 401
          ? 'Authorization failed. Please check your API key (try /login).'
          : status === 404
            ? 'Profile endpoint not available. Try Kimi For Coding.'
            : `Failed to fetch profile: HTTP ${String(status)}`;
      return { kind: 'error', status, message: await readApiErrorMessage(res, hint) };
    }
    const json: unknown = await res.json();
    const me = parseManagedUserInfoPayload(json);
    if (me === null) {
      return { kind: 'error', message: 'Failed to fetch profile: malformed response.' };
    }
    return { kind: 'ok', userInfo: me };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to fetch profile: request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to fetch profile: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
