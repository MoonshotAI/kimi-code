import { describe, expect, it } from 'vitest';

import {
  isCanaryVersion,
  planManualUpdate,
  resolveUpdateChannel,
  selectUpdateTarget,
} from '#/cli/update/select';
import type { ChannelSelection } from '#/cli/update/types';

const CANARY = '2.5.0-canary.202610260043';
const DEFAULT: ChannelSelection = { channel: 'stable', origin: 'default' };
const STABLE_ENV: ChannelSelection = { channel: 'stable', origin: 'env' };
const CANARY_ENV: ChannelSelection = { channel: 'canary', origin: 'env' };

describe('selectUpdateTarget', () => {
  it('returns the latest version when it is newer than current', () => {
    expect(selectUpdateTarget('0.4.0', '0.5.0')).toEqual({ version: '0.5.0' });
  });

  it('returns null when latest equals current', () => {
    expect(selectUpdateTarget('0.5.0', '0.5.0')).toBeNull();
  });

  it('returns null when latest is older than current', () => {
    expect(selectUpdateTarget('0.6.0', '0.5.0')).toBeNull();
  });

  it('returns null when latest is null (cache empty)', () => {
    expect(selectUpdateTarget('0.5.0', null)).toBeNull();
  });

  it('returns null when current is not a valid semver', () => {
    expect(selectUpdateTarget('not-a-version', '0.5.0')).toBeNull();
  });

  it('returns null when latest is not a valid semver', () => {
    expect(selectUpdateTarget('0.5.0', 'not-a-version')).toBeNull();
  });

  it('handles prerelease semver comparisons correctly', () => {
    expect(selectUpdateTarget('0.5.0-rc.1', '0.5.0')).toEqual({ version: '0.5.0' });
    expect(selectUpdateTarget('0.5.0', '0.5.0-rc.1')).toBeNull();
  });
});

describe('resolveUpdateChannel', () => {
  it('defaults to stable when KIMI_CODE_UPDATE_CHANNEL is unset or blank', () => {
    expect(resolveUpdateChannel({})).toEqual(DEFAULT);
    expect(resolveUpdateChannel({ KIMI_CODE_UPDATE_CHANNEL: '  ' })).toEqual(DEFAULT);
  });

  it('accepts stable and canary case-insensitively', () => {
    expect(resolveUpdateChannel({ KIMI_CODE_UPDATE_CHANNEL: 'stable' })).toEqual(STABLE_ENV);
    expect(resolveUpdateChannel({ KIMI_CODE_UPDATE_CHANNEL: ' Canary ' })).toEqual(CANARY_ENV);
  });

  it('falls back to stable for an unknown value and keeps it for the warning', () => {
    expect(resolveUpdateChannel({ KIMI_CODE_UPDATE_CHANNEL: 'nightly' })).toEqual({
      channel: 'stable',
      origin: 'invalid',
      raw: 'nightly',
    });
  });
});

describe('isCanaryVersion', () => {
  it('recognizes only canary prereleases', () => {
    expect(isCanaryVersion(CANARY)).toBe(true);
    expect(isCanaryVersion('2.5.0')).toBe(false);
    expect(isCanaryVersion('2.5.0-rc.1')).toBe(false);
    expect(isCanaryVersion('not-a-version')).toBe(false);
  });
});

describe('planManualUpdate', () => {
  it('upgrades whenever the channel reports a newer version', () => {
    expect(planManualUpdate('2.4.0', CANARY, CANARY_ENV)).toEqual({
      kind: 'upgrade',
      target: { version: CANARY },
    });
    expect(planManualUpdate(CANARY, '2.5.0', DEFAULT)).toEqual({
      kind: 'upgrade',
      target: { version: '2.5.0' },
    });
  });

  it('switches a canary build to an older stable only when the env asks for stable', () => {
    expect(planManualUpdate(CANARY, '2.4.1', STABLE_ENV)).toEqual({
      kind: 'switch-to-stable',
      target: { version: '2.4.1' },
    });
  });

  it('holds a canary build on the default or an invalid channel', () => {
    expect(planManualUpdate(CANARY, '2.4.1', DEFAULT)).toEqual({ kind: 'canary-hold', stable: '2.4.1' });
    expect(
      planManualUpdate(CANARY, '2.4.1', { channel: 'stable', origin: 'invalid', raw: 'nightly' }),
    ).toEqual({ kind: 'canary-hold', stable: '2.4.1' });
  });

  it('never plans a downgrade for stable builds or on the canary channel', () => {
    expect(planManualUpdate('2.4.1', '2.4.0', STABLE_ENV)).toEqual({ kind: 'up-to-date' });
    expect(planManualUpdate(CANARY, '2.4.1', CANARY_ENV)).toEqual({ kind: 'up-to-date' });
    expect(planManualUpdate(CANARY, null, STABLE_ENV)).toEqual({ kind: 'up-to-date' });
  });
});
