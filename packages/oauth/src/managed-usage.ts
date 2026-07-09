/**
 * Managed-platform usage fetch / parse.
 *
 * Only `managed:kimi-code` is supported today. The platform exposes a
 * `/usages` endpoint that returns a payload of the shape:
 *
 *   {
 *     "usage":  { "name": "Weekly limit", "used": 40, "limit": 1000, "resetAt": "..." },
 *     "limits": [
 *       { "detail": {"used":1, "limit":100, "name":"5h limit"}, "window": {...} },
 *       ...
 *     ]
 *   }
 *
 * The parser is intentionally loose because field spelling / casing
 * drifted across versions (`used` vs `remaining`, `resetAt` vs
 * `reset_at`, `duration+timeUnit` window labels, etc.).
 */

import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';

const MANAGED_PREFIX = 'managed:';
const KIMI_CODE_PLATFORM_ID = 'kimi-code';
export const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

export function isManagedKimiCode(providerKey?: string | null): boolean {
  if (!providerKey) return false;
  if (!providerKey.startsWith(MANAGED_PREFIX)) return false;
  return providerKey.slice(MANAGED_PREFIX.length) === KIMI_CODE_PLATFORM_ID;
}

export function kimiCodeBaseUrl(): string {
  return process.env['KIMI_CODE_BASE_URL'] ?? DEFAULT_KIMI_CODE_BASE_URL;
}

export function kimiCodeUsageUrl(): string {
  return `${kimiCodeBaseUrl().replace(/\/+$/, '')}/usages`;
}

export interface UsageRow {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly resetHint?: string | undefined;
}

export interface BoosterWalletInfo {
  /** Remaining balance in whole cents (from balance.amountLeft). */
  readonly balanceCents: number;
  /** Total balance in whole cents (from balance.amount). */
  readonly totalCents: number;
  /** Whether the user enabled a monthly spending cap. */
  readonly monthlyChargeLimitEnabled: boolean;
  /** Monthly spending cap in whole cents; 0 means unlimited. */
  readonly monthlyChargeLimitCents: number;
  /** Monthly spend so far in whole cents. */
  readonly monthlyUsedCents: number;
  /** ISO currency code, e.g. USD / CNY. */
  readonly currency: string;
}

export interface ParsedManagedUsage {
  readonly summary: UsageRow | null;
  readonly limits: UsageRow[];
  readonly extraUsage: BoosterWalletInfo | null;
}

const FIXED_POINT_CENTS = 1_000_000;

function fixedPointToCents(value: number): number {
  const cents = value / FIXED_POINT_CENTS;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

function parseMoney(raw: unknown): { cents: number; currency: string } | null {
  if (!isRecord(raw)) return null;
  const cents = toInt(raw['priceInCents']);
  if (cents === null) return null;
  const currency = typeof raw['currency'] === 'string' ? raw['currency'] : '';
  return { cents, currency };
}

function parseBoosterWallet(raw: unknown): BoosterWalletInfo | null {
  if (!isRecord(raw)) return null;
  const balance = raw['balance'];
  if (!isRecord(balance)) return null;
  if (balance['type'] !== 'BOOSTER') return null;
  const amountRaw = toInt(balance['amount']);
  if (amountRaw === null || amountRaw <= 0) return null;
  const totalCents = fixedPointToCents(amountRaw);
  const amountLeftRaw = toInt(balance['amountLeft']);
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

export function parseManagedUsagePayload(payload: unknown): ParsedManagedUsage {
  if (typeof payload !== 'object' || payload === null) {
    return { summary: null, limits: [], extraUsage: null };
  }
  const rec = payload as Record<string, unknown>;
  const summary = toUsageRow(rec['usage'], 'Weekly limit');
  const limits: UsageRow[] = [];
  const rawLimits = rec['limits'];
  if (Array.isArray(rawLimits)) {
    for (let idx = 0; idx < rawLimits.length; idx++) {
      const item = rawLimits[idx] as Record<string, unknown> | undefined;
      if (!item || typeof item !== 'object') continue;
      const detailRaw = item['detail'];
      const detail = isRecord(detailRaw) ? detailRaw : item;
      const windowRaw = item['window'];
      const window = isRecord(windowRaw) ? windowRaw : {};
      const label = limitLabel(item, detail, window, idx);
      const row = toUsageRow(detail, label);
      if (row !== null) limits.push(row);
    }
  }
  const extraUsage = parseBoosterWallet(rec['boosterWallet']);
  return { summary, limits, extraUsage };
}

function toUsageRow(raw: unknown, defaultLabel: string): UsageRow | null {
  if (!isRecord(raw)) return null;
  const limit = toInt(raw['limit']);
  let used = toInt(raw['used']);
  if (used === null) {
    const remaining = toInt(raw['remaining']);
    if (remaining !== null && limit !== null) {
      used = limit - remaining;
    }
  }
  if (used === null && limit === null) return null;
  const name =
    typeof raw['name'] === 'string'
      ? raw['name']
      : typeof raw['title'] === 'string'
        ? raw['title']
        : defaultLabel;
  const resetHint = resetHintFrom(raw);
  return {
    label: name,
    used: used ?? 0,
    limit: limit ?? 0,
    resetHint,
  };
}

function limitLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  idx: number,
): string {
  for (const key of ['name', 'title', 'scope']) {
    const v = item[key] ?? detail[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  const duration = toInt(window['duration'] ?? item['duration'] ?? detail['duration']);
  const rawUnit = window['timeUnit'] ?? item['timeUnit'] ?? detail['timeUnit'];
  const timeUnit = typeof rawUnit === 'string' ? rawUnit : '';
  if (duration !== null) {
    if (timeUnit.includes('MINUTE')) {
      if (duration >= 60 && duration % 60 === 0) return `${String(duration / 60)}h limit`;
      return `${String(duration)}m limit`;
    }
    if (timeUnit.includes('HOUR')) return `${String(duration)}h limit`;
    if (timeUnit.includes('DAY')) return `${String(duration)}d limit`;
    return `${String(duration)}s limit`;
  }
  return `Limit #${String(idx + 1)}`;
}

function resetHintFrom(raw: Record<string, unknown>): string | undefined {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const v = raw[key];
    if (typeof v === 'string' && v.length > 0) {
      return formatResetTime(v);
    }
  }
  for (const key of ['reset_in', 'resetIn', 'ttl', 'window']) {
    const seconds = toInt(raw[key]);
    if (seconds !== null && seconds > 0) {
      return `resets in ${formatDuration(seconds)}`;
    }
  }
  return undefined;
}

export function formatResetTime(val: string): string {
  let normalised = val;
  // ISO with nano precision → trim to ms for JS Date.
  if (normalised.includes('.') && normalised.endsWith('Z')) {
    const [base, frac] = normalised.slice(0, -1).split('.');
    if (base !== undefined && frac !== undefined) {
      normalised = `${base}.${frac.slice(0, 3)}Z`;
    }
  }
  const parsed = Date.parse(normalised);
  if (!Number.isFinite(parsed)) return `resets at ${val}`;
  const diffSec = Math.floor((parsed - Date.now()) / 1000);
  if (diffSec <= 0) return 'reset';
  return `resets in ${formatDuration(diffSec)}`;
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

function toInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

// ── HTTP fetch ────────────────────────────────────────────────────────

export interface FetchManagedUsageResult {
  readonly kind: 'ok';
  readonly parsed: ParsedManagedUsage;
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
    return { kind: 'ok', parsed: parseManagedUsagePayload(json) };
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
