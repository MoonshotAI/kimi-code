import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setFailureToastSender, showFailureDialog, showFailureFeedback } from '../../../src/main/app/failure-dialog';

const mocks = vi.hoisted(() => ({
  getLocale: vi.fn(),
  getRuntimeLocale: vi.fn(),
  showMessageBox: vi.fn(),
  writeText: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getLocale: mocks.getLocale },
  clipboard: { writeText: mocks.writeText },
  dialog: { showMessageBox: mocks.showMessageBox },
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { warn: mocks.warn },
}));

vi.mock('../../../src/main/diagnostics/track', () => ({
  getRuntimeLocale: mocks.getRuntimeLocale,
  trySendDesktopEvent: vi.fn(),
}));

const zh = { title: '无法打开链接', detail: '系统未能调起浏览器，请复制链接后手动打开', ok: '确定', copyLink: '复制链接' };
const en = { title: "Couldn't open link", detail: "Couldn't open your browser. Copy the link and open it manually", ok: 'OK', copyLink: 'Copy link' };
const url = 'https://example.com/docs?token=secret';

describe('showFailureDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFailureToastSender(() => false);
    mocks.getRuntimeLocale.mockReturnValue(undefined);
  });

  it('shows localized non-blocking feedback', async () => {
    mocks.getLocale.mockReturnValue('zh-CN');
    mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    showFailureDialog(zh, en);
    expect(mocks.showMessageBox).toHaveBeenCalledWith({
      type: 'warning',
      title: zh.title,
      message: zh.title,
      detail: zh.detail,
      buttons: [zh.ok],
      defaultId: 0,
      noLink: true,
    });
    await Promise.resolve();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('prefers the synchronized renderer locale over the OS locale', async () => {
    mocks.getLocale.mockReturnValue('en-US');
    mocks.getRuntimeLocale.mockReturnValue('zh');
    mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    showFailureDialog(zh, en);
    expect(mocks.showMessageBox).toHaveBeenCalledWith({
      type: 'warning',
      title: zh.title,
      message: zh.title,
      detail: zh.detail,
      buttons: [zh.ok],
      defaultId: 0,
      noLink: true,
    });
    await Promise.resolve();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('offers a copy-link button and copies the exact URL', async () => {
    mocks.getLocale.mockReturnValue('en-US');
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    showFailureDialog(zh, en, url);
    expect(mocks.showMessageBox).toHaveBeenCalledWith({
      type: 'warning',
      title: en.title,
      message: en.title,
      detail: en.detail,
      buttons: [en.ok, en.copyLink],
      defaultId: 0,
      noLink: true,
    });
    await Promise.resolve();
    expect(mocks.writeText).toHaveBeenCalledWith(url);
  });

  it('handles dialog rejection without an unhandled rejection', async () => {
    const failure = new Error('dialog unavailable');
    mocks.getLocale.mockReturnValue('en-US');
    mocks.showMessageBox.mockRejectedValue(failure);
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown): void => {
      unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      showFailureDialog(zh, en);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(mocks.warn).toHaveBeenCalledWith(`[kimi-desktop] failure dialog failed: ${String(failure)}`);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

describe('showFailureFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFailureToastSender(() => false);
    mocks.getRuntimeLocale.mockReturnValue(undefined);
    mocks.getLocale.mockReturnValue('en-US');
    mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
  });

  it('uses the renderer toast without opening a native dialog', () => {
    const send = vi.fn(() => true);
    setFailureToastSender(send);
    showFailureFeedback('external-link', zh, en, url);
    expect(send).toHaveBeenCalledWith('external-link', url);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('falls back to the native dialog when the renderer is unavailable', () => {
    setFailureToastSender(() => false);
    showFailureFeedback('external-link', zh, en);
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
  });

  it('falls back to the native dialog when toast delivery throws', () => {
    const failure = new Error('renderer gone');
    setFailureToastSender(() => {
      throw failure;
    });
    showFailureFeedback('external-link', zh, en);
    expect(mocks.warn).toHaveBeenCalledWith(`[kimi-desktop] failure toast failed: ${String(failure)}`);
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
  });
});
