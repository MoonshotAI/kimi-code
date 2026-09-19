import { createHash } from 'node:crypto';

import { eq, gte, lt, valid } from 'semver';

import type { BannerDisplay, BannerState } from '#/tui/types';

import { meetsBannerAudience, type BannerAudienceContext } from './audience';
import { getBannerConfig } from './banner-config';
import type { BannerDisplayState } from './state';

interface BannerVersionFields {
  banner_min_version?: string | null;
  banner_max_version?: string | null;
  banner_version?: string | null;
}

interface BannerTipItem extends BannerVersionFields {
  banner_id?: unknown;
  banner_enabled?: unknown;
  banner_title?: unknown;
  banner_maintext?: unknown;
  banner_subtext?: unknown;
  banner_start_time?: unknown;
  banner_end_time?: unknown;
  banner_display?: unknown;
  banner_display_ttl_hours?: unknown;
  banner_platform?: unknown;
  banner_system?: unknown;
  banner_audience?: unknown;
}

interface BannerTipsJson {
  banner_tips?: unknown;
}

interface BannerHashInput {
  tag: string | null;
  mainText: string | null;
  subText: string | null;
  startTime: string | null;
  endTime: string | null;
  display: BannerDisplay;
  ttlHours?: number;
  audience: unknown;
}

interface BannerCandidateInput {
  id: unknown;
  tag: string | null;
  mainText: string | null;
  subText: unknown;
  display: BannerDisplay;
  ttlHours?: number;
  startTime?: unknown;
  endTime?: unknown;
  audience: unknown;
}

export interface SelectBannerStateArgs {
  json: unknown;
  clientVersion: string;
  now: Date;
  random: () => number;
  audience: BannerAudienceContext;
  system: string;
}

export interface SelectDisplayableBannerArgs extends SelectBannerStateArgs {
  state: BannerDisplayState;
}

export interface BannerProviderLoadOptions {
  state?: BannerDisplayState;
  now?: Date;
  random?: () => number;
  audience?: BannerAudienceContext | Promise<BannerAudienceContext>;
  system?: string;
}

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_COOLDOWN_TTL_HOURS = 24;

const UNKNOWN_AUDIENCE: BannerAudienceContext = { login: 'unknown' };

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

type VersionConstraintCompare = (current: string, target: string) => boolean;

function meetsVersionConstraint(
  constraint: unknown,
  clientVersion: string,
  compare: VersionConstraintCompare,
): boolean {
  if (constraint === undefined || constraint === null) return true;
  if (typeof constraint !== 'string' || constraint.length === 0) return true;
  const target = valid(constraint);
  const current = valid(clientVersion);
  if (target === null || current === null) return false;
  return compare(current, target);
}

function meetsVersion(banner: BannerVersionFields, clientVersion: string): boolean {
  return (
    meetsVersionConstraint(banner.banner_min_version, clientVersion, gte) &&
    meetsVersionConstraint(banner.banner_max_version, clientVersion, lt) &&
    meetsVersionConstraint(banner.banner_version, clientVersion, eq)
  );
}

/** The CLI shows banners targeting every platform (missing / empty / 'all')
    or the CLI itself; any other platform value ('desktop', 'web', …) hides
    the banner here. */
function meetsPlatform(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const platform = value.trim().toLowerCase();
  return platform === '' || platform === 'all' || platform === 'cli';
}

/** The current operating system as a banner_system token: 'mac' / 'win' /
    'linux', with anything else passed through verbatim. */
export function currentBannerSystem(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return platform;
}

/** A missing / empty / non-array banner_system targets every system;
    otherwise the current system must be listed. */
function meetsBannerSystem(value: unknown, system: string): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return true;
  const systems = value
    .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
    .filter((entry) => entry.length > 0);
  if (systems.length === 0) return true;
  return systems.includes(system);
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
    input.mainText ?? '',
    input.subText ?? '',
    input.startTime ?? '',
    input.endTime ?? '',
    input.display,
    input.ttlHours ?? '',
    input.audience ?? null,
  ]);
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function getBannerKey(rawBannerId: unknown, input: BannerHashInput): string {
  return normalizeBannerId(rawBannerId) ?? hashBannerIdentity(input);
}

function toBannerState(input: BannerCandidateInput): BannerState {
  const subText = normalizeText(input.subText);
  const display = input.display;
  const ttlHours = display === 'cooldown' ? parseBannerDisplayTtlHours(input.ttlHours) : undefined;
  const startTime = normalizeText(input.startTime);
  const endTime = normalizeText(input.endTime);
  const key = getBannerKey(input.id, {
    tag: input.tag,
    mainText: input.mainText,
    subText,
    startTime,
    endTime,
    display,
    ttlHours,
    audience: input.audience,
  });

  return {
    key,
    tag: input.tag,
    mainText: input.mainText,
    subText,
    display,
    ttlHours,
  };
}

function pickCandidates(
  json: BannerTipsJson,
  clientVersion: string,
  now: Date,
  audience: BannerAudienceContext,
  system: string,
): BannerState[] {
  const list = Array.isArray(json.banner_tips) ? json.banner_tips : [];
  const candidates: BannerState[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const item = raw as BannerTipItem;
    if (item.banner_enabled !== true) continue;
    if (!meetsVersion(item, clientVersion)) continue;
    if (!meetsPlatform(item.banner_platform)) continue;
    if (!meetsBannerSystem(item.banner_system, system)) continue;
    const start = parseDate(item.banner_start_time);
    const end = parseDate(item.banner_end_time);
    if (!isWithinWindow(start, end, now)) continue;
    const mainText = normalizeText(item.banner_maintext);
    const tag = normalizeTag(item.banner_title);
    if (mainText === null && tag === null) continue;
    if (!meetsBannerAudience(item.banner_audience, audience)) continue;
    const display = parseBannerDisplay(item.banner_display);
    candidates.push(
      toBannerState({
        id: item.banner_id,
        tag,
        mainText,
        subText: item.banner_subtext,
        display,
        ttlHours:
          display === 'cooldown' ? parseBannerDisplayTtlHours(item.banner_display_ttl_hours) : undefined,
        startTime: item.banner_start_time,
        endTime: item.banner_end_time,
        audience: item.banner_audience,
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

export function selectBannerState(args: SelectBannerStateArgs): BannerState | null {
  const typed = typeof args.json === 'object' && args.json !== null ? (args.json as BannerTipsJson) : {};
  return pickRandomCandidate(
    pickCandidates(typed, args.clientVersion, args.now, args.audience, args.system),
    args.random,
  );
}

export function selectDisplayableBanner(args: SelectDisplayableBannerArgs): BannerState | null {
  const typed = typeof args.json === 'object' && args.json !== null ? (args.json as BannerTipsJson) : {};
  const candidates = pickCandidates(typed, args.clientVersion, args.now, args.audience, args.system).filter(
    (candidate) => shouldDisplayBanner(candidate, args.state, args.now),
  );
  return pickRandomCandidate(candidates, args.random);
}

export class BannerProvider {
  constructor(private readonly clientVersion: string) {}

  async load(options: BannerProviderLoadOptions = {}): Promise<BannerState | null> {
    // getBannerConfig never throws; undefined means "config unavailable". An
    // audience promise that rejects unexpectedly downgrades to "unknown", the
    // same classification as a userinfo network failure.
    const [json, audience] = await Promise.all([
      getBannerConfig(),
      Promise.resolve(options.audience ?? UNKNOWN_AUDIENCE).catch(() => UNKNOWN_AUDIENCE),
    ]);
    if (json === undefined) return null;
    const now = options.now ?? new Date();
    const random = options.random ?? Math.random;
    const system = options.system ?? currentBannerSystem();
    const args = { json, clientVersion: this.clientVersion, now, random, audience, system };
    return options.state === undefined
      ? selectBannerState(args)
      : selectDisplayableBanner({ ...args, state: options.state });
  }
}
