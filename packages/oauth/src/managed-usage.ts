import { z } from 'zod';

import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';

const MANAGED_PREFIX = 'managed:';
const KIMI_CODE_PLATFORM_ID = 'kimi-code';
export const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
export const GLOBAL_KIMI_CODE_BASE_URL = 'https://api.kimi.ai/coding/v1';

export function isManagedKimiCode(providerKey?: string | null): boolean {
  if (!providerKey) return false;
  if (!providerKey.startsWith(MANAGED_PREFIX)) return false;
  return providerKey.slice(MANAGED_PREFIX.length) === KIMI_CODE_PLATFORM_ID;
}

export function kimiCodeBaseUrl(): string {
  return (process.env['KIMI_CODE_BASE_URL'] ?? DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, '');
}

export function kimiCodeUsageUrl(): string {
  return `${kimiCodeBaseUrl()}/usages`;
}

export function isManagedKimiCodeBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  const candidate = parseNormalizedUrl(baseUrl);
  if (candidate === undefined) return false;
  const envOverride = process.env['KIMI_CODE_BASE_URL'];
  const managed =
    envOverride !== undefined
      ? [envOverride]
      : [DEFAULT_KIMI_CODE_BASE_URL, GLOBAL_KIMI_CODE_BASE_URL];
  return managed.some((url) => parseNormalizedUrl(url) === candidate);
}

function parseNormalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${String(days)}d`);
  if (hours) parts.push(`${String(hours)}h`);
  if (minutes) parts.push(`${String(minutes)}m`);
  if (secs && parts.length === 0) parts.push(`${String(secs)}s`);
  return parts.length > 0 ? parts.join(' ') : '0s';
}

export const managedQuotaEntrySchema = z.object({
  usedRatio: z.number(),
  resetAt: z.string().optional(),
});
export type ManagedQuotaEntry = z.infer<typeof managedQuotaEntrySchema>;

export const managedQuotaUsagesSchema = z.object({
  limit5h: managedQuotaEntrySchema.optional(),
  limit7d: managedQuotaEntrySchema.optional(),
  monthTotal: managedQuotaEntrySchema.optional(),
  monthCode: managedQuotaEntrySchema.optional(),
});
export type ManagedQuotaUsages = z.infer<typeof managedQuotaUsagesSchema>;

export const boosterWalletInfoSchema = z.object({
  balanceCents: z.number().int(),
  totalCents: z.number().int(),
  monthlyChargeLimitEnabled: z.boolean(),
  monthlyChargeLimitCents: z.number().int(),
  monthlyUsedCents: z.number().int(),
  currency: z.string(),
});
export type BoosterWalletInfo = z.infer<typeof boosterWalletInfoSchema>;

export const managedQuotaSchema = z.object({
  usages: managedQuotaUsagesSchema,
  extraUsage: boosterWalletInfoSchema.nullable(),
});
export type ManagedQuota = z.infer<typeof managedQuotaSchema>;

const managedUsageOkSchema = z.object({
  kind: z.literal('ok'),
  quota: managedQuotaSchema,
});

const managedUsageErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  status: z.number().int().optional(),
});

export const managedUsageResultSchema = z.discriminatedUnion('kind', [
  managedUsageOkSchema,
  managedUsageErrorSchema,
]);
export type ManagedUsageResult = z.infer<typeof managedUsageResultSchema>;

export function parseManagedUsagePayload(payload: unknown): ManagedQuota {
  if (!isRecord(payload)) {
    return { usages: {}, extraUsage: null };
  }
  return {
    usages: parseQuotaUsages(payload['usages']),
    extraUsage: parseBoosterWallet(payload['boosterWallet']),
  };
}

function parseQuotaUsages(raw: unknown): ManagedQuotaUsages {
  if (!isRecord(raw)) return {};
  return {
    limit5h: parseQuotaEntry(raw['limit_5h']),
    limit7d: parseQuotaEntry(raw['limit_7d']),
    monthTotal: parseQuotaEntry(raw['limit_month_total']),
    monthCode: parseQuotaEntry(raw['limit_month_code']),
  };
}

function parseQuotaEntry(raw: unknown): ManagedQuotaEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const usedRatio = ratioValue(raw['used_ratio']);
  if (usedRatio === undefined) return undefined;
  const resetAt = raw['reset_time'];
  return {
    usedRatio,
    resetAt: typeof resetAt === 'string' && resetAt.length > 0 ? resetAt : undefined,
  };
}

const FIXED_POINT_CENTS = 1_000_000;

function fixedPointToCents(value: number): number {
  const cents = value / FIXED_POINT_CENTS;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

function parseMoney(raw: unknown): { cents: number; currency: string } | null {
  if (!isRecord(raw)) return null;
  const cents = intValue(raw['priceInCents']);
  if (cents === null) return null;
  const currency = typeof raw['currency'] === 'string' ? raw['currency'] : '';
  return { cents, currency };
}

function parseBoosterWallet(raw: unknown): BoosterWalletInfo | null {
  if (!isRecord(raw)) return null;
  const balance = raw['balance'];
  if (!isRecord(balance)) return null;
  if (balance['type'] !== 'BOOSTER') return null;
  const amountRaw = intValue(balance['amount']);
  if (amountRaw === null || amountRaw <= 0) return null;
  const totalCents = fixedPointToCents(amountRaw);
  const amountLeftRaw = intValue(balance['amountLeft']);
  const balanceCents = amountLeftRaw !== null ? fixedPointToCents(amountLeftRaw) : 0;

  const monthlyLimit = parseMoney(raw['monthlyChargeLimit']);
  const monthlyUsed = parseMoney(raw['monthlyUsed']);
  const monthlyChargeLimitEnabled = raw['monthlyChargeLimitEnabled'] === true;

  const currency =
    monthlyLimit && monthlyLimit.currency.length > 0
      ? monthlyLimit.currency
      : monthlyUsed && monthlyUsed.currency.length > 0
        ? monthlyUsed.currency
        : 'USD';

  return {
    balanceCents,
    totalCents,
    monthlyChargeLimitEnabled,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
    monthlyUsedCents: monthlyUsed?.cents ?? 0,
    currency,
  };
}

function intValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function ratioValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export interface FetchManagedUsageResult {
  readonly kind: 'ok';
  readonly quota: ManagedQuota;
}

export interface FetchManagedUsageError {
  readonly kind: 'error';
  readonly status?: number;
  readonly message: string;
}

export async function fetchManagedUsage(
  url: string,
  accessToken: string,
  opts: { timeoutMs?: number } = {},
): Promise<FetchManagedUsageResult | FetchManagedUsageError> {
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
            ? 'Usage endpoint not available. Try Kimi For Coding.'
            : `Failed to fetch usage: HTTP ${String(status)}`;
      return { kind: 'error', status, message: await readApiErrorMessage(res, hint) };
    }
    const json: unknown = await res.json();
    return { kind: 'ok', quota: parseManagedUsagePayload(json) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to fetch usage: request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to fetch usage: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
