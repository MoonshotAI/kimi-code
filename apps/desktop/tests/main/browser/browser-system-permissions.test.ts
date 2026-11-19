import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getMediaAccessStatus: vi.fn(), openExternal: vi.fn(async () => undefined) }));
vi.mock('electron', () => ({
  systemPreferences: { getMediaAccessStatus: mocks.getMediaAccessStatus },
  shell: { openExternal: mocks.openExternal },
}));

import { getBrowserSystemPermissionDenials, openBrowserSystemPermissionSettings } from '../../../src/main/browser/browser-system-permissions';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

function stubPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value });
}

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

describe('browser system permissions', () => {
  it('reports camera and microphone only when the OS status is denied or restricted', () => {
    stubPlatform('darwin');
    mocks.getMediaAccessStatus.mockImplementation((kind: string) => (kind === 'camera' ? 'denied' : 'granted'));
    expect(getBrowserSystemPermissionDenials()).toEqual(['camera']);
    mocks.getMediaAccessStatus.mockImplementation((kind: string) => (kind === 'microphone' ? 'restricted' : 'not-determined'));
    expect(getBrowserSystemPermissionDenials()).toEqual(['microphone']);
    mocks.getMediaAccessStatus.mockReturnValue('unknown');
    expect(getBrowserSystemPermissionDenials()).toEqual([]);
  });

  it('queries OS state on win32 but never on platforms without a media permission model', () => {
    stubPlatform('win32');
    mocks.getMediaAccessStatus.mockReturnValue('denied');
    expect(getBrowserSystemPermissionDenials()).toEqual(['camera', 'microphone']);
    stubPlatform('linux');
    expect(getBrowserSystemPermissionDenials()).toEqual([]);
    expect(mocks.getMediaAccessStatus).toHaveBeenCalledTimes(2);
  });

  it('opens the platform-specific settings page and rejects unmappable requests', async () => {
    stubPlatform('darwin');
    await openBrowserSystemPermissionSettings('camera');
    expect(mocks.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera');
    stubPlatform('win32');
    await openBrowserSystemPermissionSettings('microphone');
    expect(mocks.openExternal).toHaveBeenCalledWith('ms-settings:privacy-microphone');
    await expect(openBrowserSystemPermissionSettings('clipboard')).rejects.toThrow('clipboard');
    stubPlatform('linux');
    await expect(openBrowserSystemPermissionSettings('camera')).rejects.toThrow('linux');
  });
});
