import { gt, prerelease, valid } from 'semver';

import { type ChannelSelection, type ManualUpdatePlan, type UpdateTarget } from './types';

export const UPDATE_CHANNEL_ENV = 'KIMI_CODE_UPDATE_CHANNEL';

export function selectUpdateTarget(
  currentVersion: string,
  latest: string | null,
): UpdateTarget | null {
  if (latest === null) return null;
  if (valid(currentVersion) === null || valid(latest) === null) return null;
  if (!gt(latest, currentVersion)) return null;
  return { version: latest };
}

/**
 * Read `KIMI_CODE_UPDATE_CHANNEL` once. Unset or empty means the default
 * stable line; unknown values also fall back to stable but stay visible as
 * `invalid` so callers can warn instead of silently ignoring a typo.
 */
export function resolveUpdateChannel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChannelSelection {
  const raw = (env[UPDATE_CHANNEL_ENV] ?? '').trim();
  if (raw === '') return { channel: 'stable', origin: 'default' };
  const normalized = raw.toLowerCase();
  if (normalized === 'stable' || normalized === 'canary') {
    return { channel: normalized, origin: 'env' };
  }
  return { channel: 'stable', origin: 'invalid', raw };
}

export function isCanaryVersion(version: string): boolean {
  if (valid(version) === null) return false;
  return prerelease(version)?.[0] === 'canary';
}

/**
 * Decide what `kimi update` does. Upgrades always win. Otherwise a canary
 * build on the stable channel either switches back (only when the user
 * explicitly asked for stable) or holds, because passive and default paths
 * never install an older version.
 */
export function planManualUpdate(
  currentVersion: string,
  latest: string | null,
  selection: ChannelSelection,
): ManualUpdatePlan {
  const target = selectUpdateTarget(currentVersion, latest);
  if (target !== null) return { kind: 'upgrade', target };
  if (
    latest === null ||
    valid(latest) === null ||
    selection.channel !== 'stable' ||
    !isCanaryVersion(currentVersion)
  ) {
    return { kind: 'up-to-date' };
  }
  if (selection.origin === 'env') {
    return { kind: 'switch-to-stable', target: { version: latest } };
  }
  return { kind: 'canary-hold', stable: latest };
}
