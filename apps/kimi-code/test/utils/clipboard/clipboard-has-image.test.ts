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

  it('falls back to osascript when native clipboard reports no image on macOS', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const runCommand = vi.fn((command: string) => {
      if (command === 'osascript') {
        return { stdout: Buffer.alloc(0), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip, runCommand });
    expect(result).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('osascript', ['-e', 'the clipboard as «class PNGf»'], expect.anything());
  });

  it('returns false when native clipboard throws and osascript fails on macOS', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => {
      throw new Error('native error');
    }) });
    const runCommand = vi.fn(() => ({ stdout: Buffer.alloc(0), ok: false }));
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip, runCommand });
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

  it('returns false on Wayland when target list contains unsupported MIME types', async () => {
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'wl-paste' && args[0] === '--list-types') {
        return { stdout: Buffer.from('text/plain\nimage/bmp\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const result = await clipboardHasImage({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      runCommand,
      clipboard: clip,
    });
    expect(result).toBe(false);
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

  it('returns false on X11 when target list contains unsupported MIME types', async () => {
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'xclip' && args.includes('TARGETS')) {
        return { stdout: Buffer.from('TARGETS\nimage/tiff\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const result = await clipboardHasImage({ platform: 'linux', env: {}, runCommand, clipboard: clip });
    expect(result).toBe(false);
  });

  it('returns false on X11 when target list is empty', async () => {
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'xclip' && args.includes('TARGETS')) {
        return { stdout: Buffer.from('TARGETS\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const result = await clipboardHasImage({ platform: 'linux', env: {}, runCommand, clipboard: clip });
    expect(result).toBe(false);
  });

  it('falls back to native hasImage on Linux X11 when xclip fails', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => true) });
    const runCommand = vi.fn(() => ({ stdout: Buffer.alloc(0), ok: false }));
    const result = await clipboardHasImage({ platform: 'linux', env: {}, clipboard: clip, runCommand });
    expect(result).toBe(true);
  });

  it('returns false on Linux X11 when xclip and native both fail', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const runCommand = vi.fn(() => ({ stdout: Buffer.alloc(0), ok: false }));
    const result = await clipboardHasImage({ platform: 'linux', env: {}, clipboard: clip, runCommand });
    expect(result).toBe(false);
  });

  it('detects WSL via WSL_DISTRO_NAME and checks PowerShell', async () => {
    const runCommand = vi.fn((command: string) => {
      if (command === 'powershell.exe') {
        return { stdout: Buffer.from('True\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      runCommand,
    });
    expect(result).toBe(true);
  });

  it('detects WSL via WSLENV and checks PowerShell', async () => {
    const runCommand = vi.fn((command: string) => {
      if (command === 'powershell.exe') {
        return { stdout: Buffer.from('True\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({
      platform: 'linux',
      env: { WSLENV: 'WT_SESSION' },
      runCommand,
    });
    expect(result).toBe(true);
  });

  it('returns false on Linux when runCommand fails for all fallbacks', async () => {
    const runCommand = vi.fn(() => ({ stdout: Buffer.alloc(0), ok: false }));
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const result = await clipboardHasImage({ platform: 'linux', env: {}, runCommand, clipboard: clip });
    expect(result).toBe(false);
  });

  it('detects image on Windows via native clipboard, skipping PowerShell', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => true) });
    const runCommand = vi.fn(() => ({ stdout: Buffer.alloc(0), ok: false }));
    const result = await clipboardHasImage({ platform: 'win32', clipboard: clip, runCommand });
    expect(result).toBe(true);
    expect(runCommand).not.toHaveBeenCalledWith('powershell.exe', expect.anything(), expect.anything());
  });

  it('falls back to PowerShell on Windows when native clipboard has no image', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const runCommand = vi.fn((command: string) => {
      if (command === 'powershell.exe') {
        return { stdout: Buffer.from('True\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({ platform: 'win32', clipboard: clip, runCommand });
    expect(result).toBe(true);
  });

  it('returns false on Windows when native and PowerShell both report no image', async () => {
    const clip = fakeClipboard({ hasImage: vi.fn(() => false) });
    const runCommand = vi.fn((command: string) => {
      if (command === 'powershell.exe') {
        return { stdout: Buffer.from('False\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
    const result = await clipboardHasImage({ platform: 'win32', clipboard: clip, runCommand });
    expect(result).toBe(false);
  });
});
