import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { UncaughtErrorNotice } from '../../../src/main/diagnostics/log';

const mocks = vi.hoisted(() => ({
  channel: 'stable',
  notice: null as UncaughtErrorNotice | null,
  window: null as { isDestroyed: () => boolean } | null,
  showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
}));

vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock('../../../src/main/diagnostics/log', () => ({
  launchChannel: () => mocks.channel,
  setUncaughtErrorNotice: (notice: UncaughtErrorNotice | null) => {
    mocks.notice = notice;
  },
}));
vi.mock('../../../src/main/window/window-registry', () => ({ getMainWindow: () => mocks.window }));

import { installUncaughtErrorNotice } from '../../../src/main/app/uncaught-error-notice';

beforeEach(() => {
  mocks.notice = null;
  mocks.window = null;
  mocks.showMessageBox.mockClear();
});

describe('installUncaughtErrorNotice', () => {
  it('registers nothing for stable builds, so their errors are only logged', () => {
    mocks.channel = 'stable';
    installUncaughtErrorNotice();
    expect(mocks.notice).toBeNull();
  });

  it.each(['canary', 'preview', 'dev'])('shows the error as a sheet on the main window in %s builds', (channel) => {
    mocks.channel = channel;
    installUncaughtErrorNotice();
    const win = { isDestroyed: () => false };
    mocks.window = win;

    mocks.notice?.({ title: 'Something failed', detail: 'stack and log path' });

    expect(mocks.showMessageBox).toHaveBeenCalledWith(win, {
      type: 'error',
      message: 'Something failed',
      detail: 'stack and log path',
    });
  });

  it('skips the sheet when there is no live main window', () => {
    mocks.channel = 'canary';
    installUncaughtErrorNotice();
    mocks.notice?.({ title: 't', detail: 'd' });
    mocks.window = { isDestroyed: () => true };
    mocks.notice?.({ title: 't', detail: 'd' });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });
});
