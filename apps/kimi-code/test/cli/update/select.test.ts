import { describe, expect, it } from 'vitest';

import { decideUpdate, resolveUpdateChannel, updateChannelForVersion } from '#/cli/update/select';
import type { ChannelSelection } from '#/cli/update/types';

const DEV = '2.5.0-dev.202610260043';
const FIXED_DEV = '0.0.0-dev.42';
const DEFAULT: ChannelSelection = { channel: 'stable', origin: 'default' };
const DEV_DEFAULT: ChannelSelection = { channel: 'dev', origin: 'default' };
const STABLE_ENV: ChannelSelection = { channel: 'stable', origin: 'env' };
const DEV_ENV: ChannelSelection = { channel: 'dev', origin: 'env' };

describe('updateChannelForVersion', () => {
  it('recognizes only dev prereleases as dev', () => {
    expect(updateChannelForVersion(DEV)).toBe('dev');
    expect(updateChannelForVersion('2.5.0')).toBe('stable');
    expect(updateChannelForVersion('2.5.0-rc.1')).toBe('stable');
    expect(updateChannelForVersion('not-a-version')).toBe('stable');
  });
});

describe('resolveUpdateChannel', () => {
  it('follows the installed channel when KIMI_CODE_UPDATE_CHANNEL is unset or blank', () => {
    expect(resolveUpdateChannel('2.5.0', 'npm-global', {})).toEqual(DEFAULT);
    expect(resolveUpdateChannel(FIXED_DEV, 'native', {})).toEqual(DEV_DEFAULT);
    expect(resolveUpdateChannel(FIXED_DEV, 'native', { KIMI_CODE_UPDATE_CHANNEL: '  ' })).toEqual(DEV_DEFAULT);
  });

  it('accepts stable and dev case-insensitively', () => {
    expect(resolveUpdateChannel(FIXED_DEV, 'native', { KIMI_CODE_UPDATE_CHANNEL: 'stable' })).toEqual(STABLE_ENV);
    expect(resolveUpdateChannel('2.5.0', 'npm-global', { KIMI_CODE_UPDATE_CHANNEL: ' Dev ' })).toEqual(DEV_ENV);
  });

  it('falls back to the installed channel for an unknown value and keeps it for the warning', () => {
    expect(resolveUpdateChannel(FIXED_DEV, 'native', { KIMI_CODE_UPDATE_CHANNEL: 'nightly' })).toEqual({
      channel: 'dev',
      origin: 'invalid',
      raw: 'nightly',
    });
  });

  it('always uses stable for Homebrew and ignores the channel variable', () => {
    expect(resolveUpdateChannel(FIXED_DEV, 'homebrew', { KIMI_CODE_UPDATE_CHANNEL: 'dev' })).toEqual({
      channel: 'stable',
      origin: 'homebrew',
    });
    expect(resolveUpdateChannel('2.5.0', 'homebrew', { KIMI_CODE_UPDATE_CHANNEL: 'nightly' })).toEqual({
      channel: 'stable',
      origin: 'homebrew',
    });
  });
});

describe('decideUpdate', () => {
  it('upgrades within a channel only when the target is newer', () => {
    expect(decideUpdate('2.4.0', { channel: 'stable', latest: '2.5.0' })).toEqual({
      kind: 'upgrade',
      target: { channel: 'stable', version: '2.5.0' },
    });
    expect(decideUpdate('0.0.0-dev.99', { channel: 'dev', latest: '0.0.0-dev.100' })).toEqual({
      kind: 'upgrade',
      target: { channel: 'dev', version: '0.0.0-dev.100' },
    });
  });

  it('returns none for an equal, older, missing, or invalid same-channel target', () => {
    for (const latest of ['2.4.0', '2.3.0', null, 'not-a-version']) {
      expect(decideUpdate('2.4.0', { channel: 'stable', latest })).toEqual({ kind: 'none' });
    }
    expect(decideUpdate('not-a-version', { channel: 'stable', latest: '2.5.0' })).toEqual({ kind: 'none' });
  });

  it('switches in either direction without comparing versions across channels', () => {
    expect(decideUpdate(DEV, { channel: 'stable', latest: '2.4.1' })).toEqual({
      kind: 'switch-channel',
      sourceChannel: 'dev',
      target: { channel: 'stable', version: '2.4.1' },
    });
    expect(decideUpdate('2.5.0', { channel: 'dev', latest: FIXED_DEV })).toEqual({
      kind: 'switch-channel',
      sourceChannel: 'stable',
      target: { channel: 'dev', version: FIXED_DEV },
    });
  });

  it('uses the selected channel rather than the target version suffix', () => {
    expect(decideUpdate(DEV, { channel: 'stable', latest: DEV })).toEqual({
      kind: 'switch-channel',
      sourceChannel: 'dev',
      target: { channel: 'stable', version: DEV },
    });
  });
});
