import { gt, prerelease, valid } from 'semver';

import {
  type ChannelSelection,
  type InstallSource,
  type UpdateChannel,
  type UpdatePlan,
  type UpdatePointer,
} from './types';

export const UPDATE_CHANNEL_ENV = 'KIMI_CODE_UPDATE_CHANNEL';

export function updateChannelForVersion(version: string): UpdateChannel {
  if (valid(version) !== null && prerelease(version)?.[0] === 'canary') return 'canary';
  return 'stable';
}

export function resolveUpdateChannel(
  currentVersion: string,
  installSource: InstallSource,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChannelSelection {
  if (installSource === 'homebrew') return { channel: 'stable', origin: 'homebrew' };
  const installed = updateChannelForVersion(currentVersion);
  const raw = (env[UPDATE_CHANNEL_ENV] ?? '').trim();
  if (raw === '') return { channel: installed, origin: 'default' };
  const normalized = raw.toLowerCase();
  if (normalized === 'stable' || normalized === 'canary') {
    return { channel: normalized, origin: 'env' };
  }
  return { channel: installed, origin: 'invalid', raw };
}

export function formatUpdateChannelWarning(selection: ChannelSelection): string | null {
  if (selection.origin !== 'invalid') return null;
  return (
    `warning: ignoring ${UPDATE_CHANNEL_ENV}=${JSON.stringify(selection.raw)}; ` +
    `expected "stable" or "canary". Using ${selection.channel}.\n`
  );
}

export function decideUpdate(
  currentVersion: string,
  pointer: UpdatePointer,
): UpdatePlan {
  if (pointer.latest === null || valid(currentVersion) === null || valid(pointer.latest) === null) {
    return { kind: 'none' };
  }
  const target = { channel: pointer.channel, version: pointer.latest };
  const sourceChannel = updateChannelForVersion(currentVersion);
  if (sourceChannel !== pointer.channel) {
    return { kind: 'switch-channel', sourceChannel, target };
  }
  if (!gt(pointer.latest, currentVersion)) return { kind: 'none' };
  return { kind: 'upgrade', target };
}
