import { describe, expect, it } from 'vitest';

import { decideUpdate, resolveUpdateChannel, updateChannelForVersion } from '#/cli/update/select';
import type { ChannelSelection } from '#/cli/update/types';

const CANARY = '2.5.0-canary.20261026004300-fedcba9';
const NEXT_CANARY = '2.5.0-canary.20261027004300-0123456';
const DEFAULT: ChannelSelection = { channel: 'stable', origin: 'default' };
const CANARY_DEFAULT: ChannelSelection = { channel: 'canary', origin: 'default' };
const STABLE_ENV: ChannelSelection = { channel: 'stable', origin: 'env' };
const CANARY_ENV: ChannelSelection = { channel: 'canary', origin: 'env' };

describe('updateChannelForVersion', () => {
  it('recognizes only canary prereleases as canary', () => {
    expect(updateChannelForVersion(CANARY)).toBe('canary');
    expect(updateChannelForVersion('2.5.0')).toBe('stable');
    expect(updateChannelForVersion('2.5.0-rc.1')).toBe('stable');
    expect(updateChannelForVersion('not-a-version')).toBe('stable');
  });
});

describe('resolveUpdateChannel', () => {
  it('follows the installed channel when KIMI_CODE_UPDATE_CHANNEL is unset or blank', () => {
    expect(resolveUpdateChannel('2.5.0', 'npm-global', {})).toEqual(DEFAULT);
    expect(resolveUpdateChannel(CANARY, 'native', {})).toEqual(CANARY_DEFAULT);
    expect(resolveUpdateChannel(CANARY, 'native', { KIMI_CODE_UPDATE_CHANNEL: '  ' })).toEqual(CANARY_DEFAULT);
  });

  it('accepts stable and canary case-insensitively', () => {
    expect(resolveUpdateChannel(CANARY, 'native', { KIMI_CODE_UPDATE_CHANNEL: 'stable' })).toEqual(STABLE_ENV);
    expect(resolveUpdateChannel('2.5.0', 'npm-global', { KIMI_CODE_UPDATE_CHANNEL: ' Canary ' })).toEqual(CANARY_ENV);
  });

  it('falls back to the installed channel for an unknown value and keeps it for the warning', () => {
    for (const raw of ['nightly', 'dev']) {
      expect(resolveUpdateChannel(CANARY, 'native', { KIMI_CODE_UPDATE_CHANNEL: raw })).toEqual({
        channel: 'canary',
        origin: 'invalid',
        raw,
      });
    }
  });

  it('always uses stable for Homebrew and ignores the channel variable', () => {
    expect(resolveUpdateChannel(CANARY, 'homebrew', { KIMI_CODE_UPDATE_CHANNEL: 'canary' })).toEqual({
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
    expect(decideUpdate(CANARY, { channel: 'canary', latest: NEXT_CANARY })).toEqual({
      kind: 'upgrade',
      target: { channel: 'canary', version: NEXT_CANARY },
    });
  });

  it('returns none for an equal, older, missing, or invalid same-channel target', () => {
    for (const latest of ['2.4.0', '2.3.0', null, 'not-a-version']) {
      expect(decideUpdate('2.4.0', { channel: 'stable', latest })).toEqual({ kind: 'none' });
    }
    expect(decideUpdate('not-a-version', { channel: 'stable', latest: '2.5.0' })).toEqual({ kind: 'none' });
    expect(decideUpdate(NEXT_CANARY, { channel: 'canary', latest: CANARY })).toEqual({ kind: 'none' });
  });

  it('switches in either direction without comparing versions across channels', () => {
    expect(decideUpdate(CANARY, { channel: 'stable', latest: '2.4.1' })).toEqual({
      kind: 'switch-channel',
      sourceChannel: 'canary',
      target: { channel: 'stable', version: '2.4.1' },
    });
    expect(decideUpdate('2.5.0', { channel: 'canary', latest: CANARY })).toEqual({
      kind: 'switch-channel',
      sourceChannel: 'stable',
      target: { channel: 'canary', version: CANARY },
    });
  });

  it('uses the selected channel rather than the target version suffix', () => {
    expect(decideUpdate(CANARY, { channel: 'stable', latest: CANARY })).toEqual({
      kind: 'switch-channel',
      sourceChannel: 'canary',
      target: { channel: 'stable', version: CANARY },
    });
  });
});
