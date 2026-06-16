import { createHash } from 'node:crypto';

import { gte, valid } from 'semver';

import { KIMI_CODE_TIPS_BANNER_URL } from '#/constant/app';
import type { BannerDisplay, BannerState } from '#/tui/types';

import type { BannerDisplayState } from './state';

interface TipsBannerFallbackItem {
  banner_id?: string | null;
  enabled?: boolean;
  banner_title?: string | null;
  banner_maintext?: string;
  banner_subtext?: string | null;
  banner_min_version?: string | null;
  banner_display?: unknown;
  banner_display_ttl_hours?: unknown;
}

interface TipsBannerJson {
  banner_id?: string | null;
  banner_enabled?: boolean;
  banner_title?: string | null;
  banner_maintext?: string;
  banner_subtext?: string | null;
  banner_start_time?: string | null;
  banner_end_time?: string | null;
  banner_min_version?: string | null;
  banner_display?: unknown;
  banner_display_ttl_hours?: unknown;
  banner_fallback_enabled?: boolean;
  banner_fallback_list?: unknown[];
}

interface BannerHashInput {
  tag: string | null;
  mainText: string;
  subText: string | null;
  startTime: string | null;
  endTime: string | null;
  display: BannerDisplay;
  ttlHours?: number;
}

interface BannerCandidateInput {
  id: unknown;
  tag: unknown;
  mainText: string;
  subText: unknown;
  display: BannerDisplay;
  ttlHours?: number;
  startTime?: unknown;
  endTime?: unknown;
}

export interface SelectDisplayableBannerArgs {
  json: unknown;
  clientVersion: string;
  now: Date;
  random: () => number;
  state: BannerDisplayState;
}

interface BannerProviderLoadOptions {
  state?: BannerDisplayState;
  now?: Date;
  random?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_COOLDOWN_TTL_HOURS = 24;

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

function parseBannerDisplay(value: unknown): BannerDisplay {
  if (value === 'once') return 'once';
  if (value === 'cooldown') return 'cooldown';
  return 'always';
}

function parseBannerDisplayTtlHours(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_COOLDOWN_TTL_HOURS;
}

function normalizeBannerId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hashBannerIdentity(input: BannerHashInput): string {
  const raw = JSON.stringify([
    input.tag ?? '',
    input.mainText,
    input.subText ?? '',
    input.startTime ?? '',
    input.endTime ?? '',
    input.display,
    input.ttlHours ?? '',
  ]);
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function getBannerKey(rawBannerId: unknown, input: BannerHashInput): string {
  return normalizeBannerId(rawBannerId) ?? hashBannerIdentity(input);
}

function toBannerState(input: BannerCandidateInput): BannerState {
  const tag = normalizeTag(input.tag);
  const subText = normalizeText(input.subText);
  const display = input.display;
  const ttlHours = display === 'cooldown' ? parseBannerDisplayTtlHours(input.ttlHours) : undefined;
  const startTime = normalizeText(input.startTime);
  const endTime = normalizeText(input.endTime);
  const key = getBannerKey(input.id, {
    tag,
    mainText: input.mainText,
    subText,
    startTime,
    endTime,
    display,
    ttlHours,
  });

  return {
    key,
    tag,
    mainText: input.mainText,
    subText,
    display,
    ttlHours,
  };
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
  const display = parseBannerDisplay(json.banner_display);
  return toBannerState({
    id: json.banner_id,
    tag: json.banner_title,
    mainText,
    subText: json.banner_subtext,
    display,
    ttlHours: display === 'cooldown' ? parseBannerDisplayTtlHours(json.banner_display_ttl_hours) : undefined,
    startTime: json.banner_start_time,
    endTime: json.banner_end_time,
  });
}

function pickFallbackCandidates(
  json: TipsBannerJson,
  clientVersion: string,
): BannerState[] {
  if (json.banner_fallback_enabled !== true) return [];
  const list = Array.isArray(json.banner_fallback_list) ? json.banner_fallback_list : [];
  const candidates: BannerState[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as TipsBannerFallbackItem;
    if (item.enabled !== true) continue;
    if (!meetsMinVersion(item.banner_min_version, clientVersion)) continue;
    const mainText = normalizeText(item.banner_maintext);
    if (mainText === null) continue;
    const display = parseBannerDisplay(item.banner_display);
    candidates.push(
      toBannerState({
        id: item.banner_id,
        tag: item.banner_title,
        mainText,
        subText: item.banner_subtext,
        display,
        ttlHours: display === 'cooldown' ? parseBannerDisplayTtlHours(item.banner_display_ttl_hours) : undefined,
      }),
    );
  }
  return candidates;
}

function pickRandomCandidate(candidates: BannerState[], random: () => number): BannerState | null {
  if (candidates.length === 0) return null;
  const index = Math.floor(random() * candidates.length);
  return candidates[index]!;
}

function pickFallbackBanner(
  json: TipsBannerJson,
  clientVersion: string,
  random: () => number,
): BannerState | null {
  return pickRandomCandidate(pickFallbackCandidates(json, clientVersion), random);
}

function parseShownAt(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCooldownTtlHours(banner: BannerState): number {
  return typeof banner.ttlHours === 'number' && Number.isFinite(banner.ttlHours) && banner.ttlHours > 0
    ? banner.ttlHours
    : DEFAULT_COOLDOWN_TTL_HOURS;
}

export function shouldDisplayBanner(
  banner: BannerState,
  state: BannerDisplayState,
  now: Date,
): boolean {
  if (banner.display === 'always') return true;
  const lastShownAt = parseShownAt(state.shown[banner.key]?.lastShownAt);
  if (lastShownAt === null) return true;
  if (banner.display === 'once') return false;
  return now.getTime() - lastShownAt.getTime() >= getCooldownTtlHours(banner) * HOUR_MS;
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
    pickFallbackBanner(typed, clientVersion, random)
  );
}

export function selectDisplayableBanner({
  json,
  clientVersion,
  now,
  random,
  state,
}: SelectDisplayableBannerArgs): BannerState | null {
  const typed = typeof json === 'object' && json !== null ? (json as TipsBannerJson) : {};
  const active = pickActiveBanner(typed, clientVersion, now);
  if (active !== null && shouldDisplayBanner(active, state, now)) return active;
  const candidates = pickFallbackCandidates(typed, clientVersion).filter((candidate) =>
    shouldDisplayBanner(candidate, state, now),
  );
  return pickRandomCandidate(candidates, random);
}

export class BannerProvider {
  constructor(
    private readonly clientVersion: string,
    private readonly url: string = KIMI_CODE_TIPS_BANNER_URL,
  ) {}

  async load(
    fetchImpl: typeof fetch = fetch,
    options: BannerProviderLoadOptions = {},
  ): Promise<BannerState | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 3000);
      const response = await fetchImpl(this.url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return null;
      const json = await response.json();
      const now = options.now ?? new Date();
      const random = options.random ?? Math.random;
      return options.state === undefined
        ? selectBannerState(json, this.clientVersion, now, random)
        : selectDisplayableBanner({
            json,
            clientVersion: this.clientVersion,
            now,
            random,
            state: options.state,
          });
    } catch {
      return null;
    }
  }
}
