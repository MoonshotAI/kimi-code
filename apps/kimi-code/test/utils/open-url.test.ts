import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

import { openUrl } from '#/utils/open-url';

describe('openUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes windowsHide so opening the browser never flashes a console window on Windows', () => {
    openUrl('http://127.0.0.1:58627/#token=t');
    expect(mocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('uses cmd /c start on win32, open on darwin, xdg-open elsewhere', () => {
    const originalPlatform = process.platform;
    try {
      for (const [platform, expectedCommand] of [
        ['win32', 'cmd'],
        ['darwin', 'open'],
        ['linux', 'xdg-open'],
      ] as const) {
        Object.defineProperty(process, 'platform', { value: platform });
        mocks.execFile.mockClear();
        openUrl('http://example.com');
        expect(mocks.execFile).toHaveBeenCalledWith(
          expectedCommand,
          expect.any(Array),
          expect.objectContaining({ windowsHide: true }),
          expect.any(Function),
        );
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
