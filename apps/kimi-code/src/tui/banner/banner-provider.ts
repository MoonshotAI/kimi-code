import { gte, valid } from 'semver';

import { KIMI_CODE_TIPS_BANNER_URL } from '#/constant/app';
import type { BannerState } from '#/tui/types';

interface TipsBannerFallbackItem {
  enabled?: boolean;
  banner_title?: string | null;
  banner_maintext?: string;
  banner_subtext?: string | null;
  banner_min_version?: string | null;
}

interface TipsBannerJson {
  banner_enabled?: boolean;
  banner_title?: string | null;
  banner_maintext?: string;
  banner_subtext?: string | null;
  banner_start_time?: string | null;
  banner_end_time?: string | null;
  banner_min_version?: string | null;
  banner_fallback_enabled?: boolean;
  banner_fallback_list?: unknown[];
}

function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUtcDate(value: string): string {
  if (value.endsWith('Z')) return value;
  if (/[+-]\d{2}:\d{2}$/.test(value)) return value;
  return `${value}Z`;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = normalizeUtcDate(value);
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinWindow(start: Date | null, end: Date | null, now: Date): boolean {
  if (start !== null && now < start) return false;
  if (end !== null && now > end) return false;
  return true;
}

function meetsMinVersion(minVersion: unknown, clientVersion: string): boolean {
  if (minVersion === undefined || minVersion === null) return true;
  if (typeof minVersion !== 'string' || minVersion.length === 0) return true;
  const min = valid(minVersion);
  const current = valid(clientVersion);
  if (min === null || current === null) return false;
  return gte(current, min);
}

function pickActiveBanner(
  json: TipsBannerJson,
  clientVersion: string,
  now: Date,
): BannerState | null {
  if (json.banner_enabled !== true) return null;
  if (!meetsMinVersion(json.banner_min_version, clientVersion)) return null;
  const start = parseDate(json.banner_start_time);
  const end = parseDate(json.banner_end_time);
  if (!isWithinWindow(start, end, now)) return null;
  const mainText = normalizeText(json.banner_maintext);
  if (mainText === null) return null;
  return {
    tag: normalizeTag(json.banner_title),
    mainText,
    subText: normalizeText(json.banner_subtext),
  };
}

function pickFallbackBanner(
  json: TipsBannerJson,
  clientVersion: string,
  now: Date,
  random: () => number,
): BannerState | null {
  if (json.banner_fallback_enabled !== true) return null;
  const list = Array.isArray(json.banner_fallback_list) ? json.banner_fallback_list : [];
  const candidates: BannerState[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as TipsBannerFallbackItem;
    if (item.enabled !== true) continue;
    if (!meetsMinVersion(item.banner_min_version, clientVersion)) continue;
    const mainText = normalizeText(item.banner_maintext);
    if (mainText === null) continue;
    candidates.push({
      tag: normalizeTag(item.banner_title),
      mainText,
      subText: normalizeText(item.banner_subtext),
    });
  }
  if (candidates.length === 0) return null;
  const index = Math.floor(random() * candidates.length);
  return candidates[index]!;
}

export function selectBannerState(
  json: unknown,
  clientVersion: string,
  now: Date,
  random: () => number,
): BannerState | null {
  const typed = typeof json === 'object' && json !== null ? (json as TipsBannerJson) : {};
  return (
    pickActiveBanner(typed, clientVersion, now) ??
    pickFallbackBanner(typed, clientVersion, now, random)
  );
}

export class BannerProvider {
  constructor(
    private readonly clientVersion: string,
    private readonly url: string = KIMI_CODE_TIPS_BANNER_URL,
  ) {}

  async load(fetchImpl: typeof fetch = fetch): Promise<BannerState | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 3000);
      const response = await fetchImpl(this.url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return null;
      const json = await response.json();
      return selectBannerState(json, this.clientVersion, new Date(), Math.random);
    } catch {
      return null;
    }
  }
}
