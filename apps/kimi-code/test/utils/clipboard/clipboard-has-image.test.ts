import { describe, expect, it, vi } from 'vitest';

import { clipboardHasImage } from '#/utils/clipboard/clipboard-has-image';
import type { ClipboardModule } from '#/utils/clipboard/clipboard-native';

function fakeClipboard(overrides: Partial<ClipboardModule>): ClipboardModule {
  return {
    hasImage: vi.fn(() => false),
    getImageBinary: vi.fn(async () => []),
    ...overrides,
  };
}

describe('clipboardHasImage', () => {
  it('returns false on Termux', async () => {
    const result = await clipboardHasImage({ env: { TERMUX_VERSION: '0.118' }, platform: 'linux' });
    expect(result).toBe(false);
  });

  it('returns true when native clipboard reports an image on macOS', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => true) });
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip });
    expect(result).toBe(true);
  });

  it('returns false when native clipboard has no image on macOS', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip });
    expect(result).toBe(false);
  });

  it('detects image on Wayland via wl-paste list-types', async () => {
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'wl-paste' && args[0] === '--list-types') {
        return { stdout: Buffer.from('text/plain\nimage/png\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1' }, runCommand });
    expect(result).toBe(true);
  });

  it('detects image on X11 via xclip TARGETS', async () => {
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'xclip' && args.includes('TARGETS')) {
        return { stdout: Buffer.from('TARGETS\nimage/jpeg\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({ platform: 'linux', env: {}, runCommand });
    expect(result).toBe(true);
  });

  it('detects image on Windows via PowerShell', async () => {
    const runCommand = vi.fn((command: string, _args: string[]) => {
      if (command === 'powershell.exe') {
        return { stdout: Buffer.from('True\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({ platform: 'win32', runCommand });
    expect(result).toBe(true);
  });

  it('returns false on Windows when PowerShell reports no image', async () => {
    const runCommand = vi.fn((command: string, _args: string[]) => {
      if (command === 'powershell.exe') {
        return { stdout: Buffer.from('False\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({ platform: 'win32', runCommand });
    expect(result).toBe(false);
  });
});
