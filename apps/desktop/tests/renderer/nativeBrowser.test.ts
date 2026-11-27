import { afterEach, describe, expect, it, vi } from 'vitest';

import { canUseNativeBrowser, getNativeBrowserBridge } from '../../src/renderer/lib/nativeBrowser';

const originalWindow = globalThis.window;

function setBridge(bridge: Record<string, unknown> | undefined): void {
  Object.defineProperty(globalThis, 'window', {
    value: bridge === undefined ? {} : { kimiDesktop: bridge },
    configurable: true,
  });
}

function completeBridge(): Record<string, unknown> {
  return {
    getBrowserState: vi.fn(),
    browserNavigate: vi.fn(),
    browserBack: vi.fn(),
    browserForward: vi.fn(),
    browserReload: vi.fn(),
    browserFind: vi.fn(),
    browserStopFind: vi.fn(),
    browserPrint: vi.fn(),
    browserZoom: vi.fn(),
    browserToggleDeviceMode: vi.fn(),
    browserSetDeviceMode: vi.fn(),
    browserCaptureScreenshot: vi.fn(),
    browserSetOccluded: vi.fn(),
    browserSetFocusEmulation: vi.fn(),
    browserGetData: vi.fn(),
    browserFocusChrome: vi.fn(),
    browserGetSites: vi.fn(),
    browserGetSite: vi.fn(),
    browserSetSitePermission: vi.fn(),
    browserSetSiteAutoplay: vi.fn(),
    browserSetSiteSound: vi.fn(),
    browserClearSiteData: vi.fn(),
    browserGetSystemPermissionStates: vi.fn(),
    browserOpenSystemPermissionSettings: vi.fn(),
    browserUpdatePreferences: vi.fn(),
    browserClearHistory: vi.fn(),
    browserClearDownloads: vi.fn(),
    browserOpenDownload: vi.fn(),
    browserGetDownloads: vi.fn(),
    browserRemoveDownload: vi.fn(),
    browserWatchDownloads: vi.fn(),
    onBrowserDownloads: vi.fn(),
    browserClearData: vi.fn(),
    browserSetBounds: vi.fn(),
    browserSetVisible: vi.fn(),
    browserClose: vi.fn(),
    browserClone: vi.fn(),
    browserTabCommand: vi.fn(),
    browserGetSessions: vi.fn(),
    browserSaveSessions: vi.fn(),
    browserSuspend: vi.fn(),
    onBrowserState: vi.fn(),
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
});

describe('native Browser bridge capability', () => {
  it.each(['browserSetOccluded', 'browserSetFocusEmulation', 'browserOpenDownload', 'browserGetDownloads', 'browserRemoveDownload', 'browserWatchDownloads', 'onBrowserDownloads'])('requires %s before exposing the bridge', method => {
    setBridge({ ...completeBridge(), [method]: undefined });
    expect(getNativeBrowserBridge()).toBeNull();
  });

  it('exposes the complete typed bridge', () => {
    const bridge = completeBridge();
    setBridge(bridge);
    expect(canUseNativeBrowser()).toBe(true);
    expect(getNativeBrowserBridge()).toBe(bridge);
  });

  it('stays unavailable on web and on partial/older desktop preloads', () => {
    setBridge(undefined);
    expect(canUseNativeBrowser()).toBe(false);
    setBridge({ ...completeBridge(), browserSetVisible: undefined });
    expect(canUseNativeBrowser()).toBe(false);
    expect(getNativeBrowserBridge()).toBeNull();
  });
});
