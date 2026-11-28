import { describe, expect, it } from 'vitest';
import {
  actionForMediaStatus,
  asSystemPermissionsQuery,
  isSystemPermissionId,
  isSystemPermissionsSnapshot,
  notificationPermissionStatus,
} from '../src/lib/systemPermissions';

describe('systemPermissions contracts', () => {
  it('maps media access statuses to UI actions', () => {
    expect(actionForMediaStatus('granted')).toBeNull();
    expect(actionForMediaStatus('restricted')).toBeNull();
    expect(actionForMediaStatus('not-determined')).toBe('request');
    expect(actionForMediaStatus('denied')).toBe('open-settings');
    expect(actionForMediaStatus('unknown')).toBeNull();
  });

  it('maps DOM notification permission values', () => {
    expect(notificationPermissionStatus('granted')).toBe('granted');
    expect(notificationPermissionStatus('denied')).toBe('denied');
    expect(notificationPermissionStatus('default')).toBe('not-determined');
    expect(notificationPermissionStatus('anything')).toBe('not-determined');
  });

  it('normalizes untrusted IPC query payloads', () => {
    expect(asSystemPermissionsQuery(null)).toEqual({ computerUseInstalled: false, notificationPermission: 'default' });
    expect(asSystemPermissionsQuery({ computerUseInstalled: 1, notificationPermission: 'yes' })).toEqual({
      computerUseInstalled: false,
      notificationPermission: 'default',
    });
    expect(asSystemPermissionsQuery({ computerUseInstalled: true, notificationPermission: 'granted' })).toEqual({
      computerUseInstalled: true,
      notificationPermission: 'granted',
    });
  });

  it('accepts known permission ids and rejects full disk access or unknown ids', () => {
    expect(isSystemPermissionId('local-network')).toBe(true);
    expect(isSystemPermissionId('cu-accessibility')).toBe(true);
    expect(isSystemPermissionId('full-disk-access')).toBe(false);
    expect(isSystemPermissionId('accessibility')).toBe(false);
  });

  it('validates snapshot shapes across the preload boundary', () => {
    expect(isSystemPermissionsSnapshot({
      platform: 'darwin',
      computerUseInstalled: false,
      items: [{ id: 'camera', status: 'granted', action: null, requiresRestart: false }],
    })).toBe(true);
    expect(isSystemPermissionsSnapshot({ platform: 'darwin', computerUseInstalled: false, items: [{ id: 'camera', status: 'granted' }] })).toBe(false);
    expect(isSystemPermissionsSnapshot(null)).toBe(false);
  });
});
