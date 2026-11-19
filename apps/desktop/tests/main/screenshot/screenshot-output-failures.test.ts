import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pinMenu } from '../../../src/main/screenshot/screenshot-output';

const mocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  error: vi.fn(),
  showFailureFeedback: vi.fn(),
  showSaveDialog: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ writeFile: mocks.writeFile }));

vi.mock('electron', () => ({
  BaseWindow: { getFocusedWindow: vi.fn(() => null) },
  BrowserWindow: vi.fn(),
  ClipboardItem: vi.fn(),
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  clipboard: { writeImage: vi.fn() },
  dialog: { showSaveDialog: mocks.showSaveDialog, showMessageBox: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  screen: {},
}));

vi.mock('../../../src/main/app/failure-dialog', () => ({ showFailureFeedback: mocks.showFailureFeedback }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { error: mocks.error } }));
vi.mock('../../../src/main/screenshot/screenshot-native', () => ({ configurePinnedScreenshot: vi.fn() }));

describe('pinned screenshot save failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildFromTemplate.mockImplementation((template: MenuItemConstructorOptions[]) => ({ template, popup: vi.fn() }));
  });

  it('handles a write failure from Save As without an unhandled rejection', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/private/screenshot.png' });
    mocks.writeFile.mockRejectedValue(failure);
    const pin = {
      png: Buffer.from('png'),
      window: { getOpacity: vi.fn(() => 1), setOpacity: vi.fn() },
    } as unknown as Parameters<typeof pinMenu>[0];
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown): void => {
      unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      pinMenu(pin, 'en');
      const template = mocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[];
      const click = template.find((item) => item.label === 'Save As…')?.click as (() => void) | undefined;
      if (click === undefined) throw new Error('Save As click handler missing');
      click();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(mocks.writeFile).toHaveBeenCalledWith('/private/screenshot.png', pin.png);
      expect(mocks.error).toHaveBeenCalledWith('[kimi-desktop] pinned screenshot save failed', failure);
      expect(mocks.showFailureFeedback).toHaveBeenCalledWith('screenshot-save', expect.any(Object), expect.any(Object));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
