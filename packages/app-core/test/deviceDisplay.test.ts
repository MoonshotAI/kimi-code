import { describe, expect, it } from 'vitest';
import type { AppDevice } from '../src/api/types';
import {
  deviceDisplayName,
  deviceDisplayState,
  deviceInstall,
  devicePlatformLabel,
  isDeviceBlocked,
  isLongOffline,
  isRetryableDeviceFailure,
} from '../src/lib/deviceDisplay';

function account(extra: Partial<AppDevice> = {}): AppDevice {
  return { id: 'rc-mac', connection: 'account', status: 'pending', ...extra };
}

function failed(connectFailure: AppDevice['connectFailure']): AppDevice {
  return account({ status: 'disconnected', connectError: 'raw error', connectFailure });
}

describe('deviceDisplayState', () => {
  it('maps the account failures to their own states and keeps the rest as failed', () => {
    const loaded = { loaded: true };
    expect(deviceDisplayState('rc-mac', failed('offline'), loaded)).toBe('offline');
    expect(deviceDisplayState('rc-mac', failed('outdated'), loaded)).toBe('outdated');
    expect(deviceDisplayState('rc-mac', failed('signed_out'), loaded)).toBe('signedOut');
    expect(deviceDisplayState('rc-mac', failed('duplicate'), loaded)).toBe('duplicate');
    expect(deviceDisplayState('rc-mac', failed('self'), loaded)).toBe('self');
    expect(deviceDisplayState('rc-mac', failed('relay_unavailable'), loaded)).toBe('failed');
    expect(deviceDisplayState('rc-mac', account({ status: 'disconnected' }), loaded)).toBe('idle');
  });

  it('keeps an offline device offline while the server retries in the background', () => {
    const retrying = account({ status: 'connecting' });
    expect(deviceDisplayState('rc-mac', retrying, { loaded: true, settledFailure: 'offline' })).toBe('offline');
    expect(deviceDisplayState('rc-mac', retrying, { loaded: true, settledFailure: 'relay_unavailable' })).toBe('connecting');
    expect(deviceDisplayState('rc-mac', retrying, { loaded: true, connecting: true, settledFailure: 'offline' })).toBe('connecting');
  });

  it('puts disabled and local states ahead of the connection status', () => {
    expect(deviceDisplayState(undefined, undefined, { loaded: true })).toBe('local');
    expect(deviceDisplayState('gone', undefined, { loaded: true })).toBe('missing');
    expect(deviceDisplayState('gone', undefined, { loaded: false })).toBe('idle');
    expect(deviceDisplayState('rc-mac', { ...failed('offline'), enabled: false }, { loaded: true })).toBe('disabled');
  });
});

describe('device display helpers', () => {
  it('blocks every state except local, ready, connecting and idle', () => {
    expect(['local', 'ready', 'connecting', 'idle'].map((state) => isDeviceBlocked(state as never))).toEqual([false, false, false, false]);
    expect(['offline', 'outdated', 'signedOut', 'duplicate', 'self', 'failed', 'disabled', 'missing'].every((state) => isDeviceBlocked(state as never))).toBe(true);
  });

  it('offers a retry only for failures that can heal on their own', () => {
    expect(isRetryableDeviceFailure('relay_unavailable')).toBe(true);
    expect(isRetryableDeviceFailure('outdated')).toBe(false);
    expect(isRetryableDeviceFailure('authentication_failed')).toBe(false);
  });

  it('names a device by its name, then its Remote Control alias, then its id', () => {
    expect(deviceDisplayName({ id: 'rc-mac', name: 'Studio', alias: 'Work Mac' })).toBe('Studio');
    expect(deviceDisplayName({ id: 'rc-mac', alias: 'Work Mac' })).toBe('Work Mac');
    expect(deviceDisplayName({ id: 'rc-mac' })).toBe('rc-mac');
  });

  it('labels platforms and splits the install kind from the client version', () => {
    expect(['darwin', 'win32', 'linux', 'freebsd'].map(devicePlatformLabel)).toEqual(['macOS', 'Windows', 'Linux', 'freebsd']);
    expect(deviceInstall('kimi-code-desktop/1.3.7')).toEqual({ install: 'desktop', version: '1.3.7' });
    expect(deviceInstall('kimi-code-cli/1.2.0')).toEqual({ install: 'cli', version: '1.2.0' });
    expect(deviceInstall('kimi-code/1.1.0')).toEqual({ install: 'cli', version: '1.1.0' });
    expect(deviceInstall('Kimi Code/1.0.0')).toBeUndefined();
  });

  it('treats a device as long offline after seven days without updates', () => {
    const now = Date.parse('2026-11-19T00:00:00.000Z');
    expect(isLongOffline({ status: 'offline', updated_at: '2026-11-11T00:00:00.000Z' }, now)).toBe(true);
    expect(isLongOffline({ status: 'offline', updated_at: '2026-11-13T00:00:00.000Z' }, now)).toBe(false);
    expect(isLongOffline({ status: 'online', updated_at: '2026-01-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isLongOffline({ status: 'offline', updated_at: '' }, now)).toBe(false);
  });
});
