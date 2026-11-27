import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { menuTemplate } from '../../../src/main/shell/menu';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  reportExternalLinkFailure: vi.fn(),
  refreshServerRegion: vi.fn(),
  serverRegionProfile: vi.fn(),
  whenServerRegionSource: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US'), isPackaged: false },
  dialog: { showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  shell: { openExternal: mocks.openExternal },
  webContents: { getFocusedWebContents: vi.fn(() => null) },
}));

vi.mock('../../../src/main/window/window-registry', () => ({
  getMainWindow: vi.fn(() => null),
  sendToRenderer: vi.fn(),
}));
vi.mock('../../../src/main/window/main-window', () => ({
  createWindow: vi.fn(),
  showMainWindow: vi.fn(),
  usesCustomTitleBar: vi.fn(() => false),
  devToolsMode: vi.fn(() => 'detach'),
}));

vi.mock('../../../src/main/server/connect', () => ({ connect: vi.fn() }));
vi.mock('../../../src/main/diagnostics/trace', () => ({
  getTraceRecorder: vi.fn(() => ({ isRecording: vi.fn(() => false) })),
}));
vi.mock('../../../src/main/diagnostics/diagnostics-export', () => ({
  exportDiagnostics: vi.fn(),
  openLogsFolder: vi.fn(),
}));
vi.mock('../../../src/main/shell/external-links', () => ({ reportExternalLinkFailure: mocks.reportExternalLinkFailure }));
vi.mock('../../../src/main/server/region', () => ({
  refreshServerRegion: mocks.refreshServerRegion,
  serverRegionProfile: mocks.serverRegionProfile,
  whenServerRegionSource: mocks.whenServerRegionSource,
}));
vi.mock('../../../src/main/release/updater', () => ({
  getUpdateAutoDownload: vi.fn(),
  getUpdateStatus: vi.fn(),
  requestUpdateCheck: vi.fn(),
  requestUpdateDownload: vi.fn(),
  requestUpdateInstall: vi.fn(),
  UPDATE_CHECK_TIMED_OUT: 'timed-out',
}));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: vi.fn(), trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/app/ui-state', () => ({ isLinuxNativeTitleBar: vi.fn(() => false) }));

function helpClick(id: 'help-docs' | 'help-console'): () => void {
  const help = menuTemplate(false, 'en').find((item) => item.label === 'Help');
  const submenu = help?.submenu as MenuItemConstructorOptions[] | undefined;
  const click = submenu?.find((item) => item.id === id)?.click as (() => void) | undefined;
  if (click === undefined) throw new Error(`${id} click handler missing`);
  return click;
}

describe('help menu external link failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whenServerRegionSource.mockResolvedValue(true);
    mocks.refreshServerRegion.mockResolvedValue('mainland-cn');
    mocks.serverRegionProfile.mockReturnValue({ siteBase: 'https://www.kimi.com' });
  });

  it.each([
    ['help-docs', 'https://www.kimi.com/code/docs/'],
    ['help-console', 'https://www.kimi.com/code/console?from=kimi_code_desktop'],
  ] as const)('handles the complete %s promise chain rejection', async (id, url) => {
    const failure = new Error('Failed to open URL');
    mocks.openExternal.mockRejectedValue(failure);
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown): void => {
      unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      helpClick(id)();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(mocks.openExternal).toHaveBeenCalledWith(url);
      expect(mocks.reportExternalLinkFailure).toHaveBeenCalledWith(url, failure);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('uses the refreshed region for the actual browser URL and failure report', async () => {
    const failure = new Error('Failed to open URL');
    mocks.serverRegionProfile
      .mockReturnValueOnce({ siteBase: 'https://www.kimi.com' })
      .mockReturnValueOnce({ siteBase: 'https://www.kimi.ai' });
    mocks.openExternal.mockRejectedValue(failure);
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown): void => {
      unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      helpClick('help-docs')();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(mocks.openExternal).toHaveBeenCalledWith('https://www.kimi.ai/code/docs/');
      expect(mocks.reportExternalLinkFailure).toHaveBeenCalledWith('https://www.kimi.ai/code/docs/', failure);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('handles a region refresh rejection before opening the browser', async () => {
    const failure = new Error('region refresh failed');
    mocks.refreshServerRegion.mockRejectedValue(failure);
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown): void => {
      unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      helpClick('help-docs')();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(mocks.reportExternalLinkFailure).toHaveBeenCalledWith('https://www.kimi.com/code/docs/', failure);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
