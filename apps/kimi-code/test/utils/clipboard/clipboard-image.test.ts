import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import type { ClipboardModule } from '#/utils/clipboard/clipboard-native';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function fakeClipboard(overrides: Partial<ClipboardModule>): ClipboardModule {
  return {
    hasImage: vi.fn(() => false),
    getImageBinary: vi.fn(async () => []),
    ...overrides,
  };
}

function noMacOsPaths(): { stdout: Buffer; ok: boolean } {
  return { stdout: Buffer.alloc(0), ok: false };
}

describe('readClipboardMedia', () => {
  it('reads a copied image file from its real path instead of the Finder preview icon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const imagePath = join(dir, 'photo.png');
      const imageBytes = png(12, 34);
      writeFileSync(imagePath, imageBytes);
      const getImageBinary = vi.fn(async () => Array.from(png(1, 1)));
      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['public.file-url', 'public.png']),
        hasImage: vi.fn(() => true),
        getImageBinary,
      });
      const runCommand = vi.fn(() => ({ stdout: Buffer.from(`${imagePath}\n`), ok: true }));

      const media = await readClipboardMedia({ platform: 'darwin', clipboard: clip, runCommand });

      expect(media).toEqual({
        kind: 'image',
        bytes: imageBytes,
        mimeType: 'image/png',
      });
      expect(getImageBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers a video file URL over an available image preview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const videoPath = join(dir, 'sample.mov');
      writeFileSync(videoPath, new Uint8Array([0, 1, 2]));
      const getImageBinary = vi.fn(async () => [0x89, 0x50, 0x4e, 0x47]);
      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['public.file-url', 'public.png']),
        hasText: vi.fn(() => true),
        getText: vi.fn(async () => pathToFileURL(videoPath).toString()),
        hasImage: vi.fn(() => true),
        getImageBinary,
      });

      const media = await readClipboardMedia({
        platform: 'darwin',
        clipboard: clip,
        runCommand: noMacOsPaths,
      });

      expect(media?.kind).toBe('video');
      expect(media).toMatchObject({
        mimeType: 'video/quicktime',
        filename: 'sample.mov',
        sourcePath: videoPath,
      });
      expect(getImageBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to native image bytes when no video file is present', async () => {
    const clip = fakeClipboard({
      availableFormats: vi.fn(() => ['public.png']),
      hasText: vi.fn(() => false),
      hasImage: vi.fn(() => true),
      getImageBinary: vi.fn(async () => [0x89, 0x50, 0x4e, 0x47]),
    });

    const media = await readClipboardMedia({
      platform: 'darwin',
      clipboard: clip,
      runCommand: noMacOsPaths,
    });

    expect(media).toEqual({
      kind: 'image',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
    });
  });

  it('does not consume file-like clipboard image previews when no real file path is readable', async () => {
    const getImageBinary = vi.fn(async () => Array.from(png(1, 1)));
    const clip = fakeClipboard({
      availableFormats: vi.fn(() => ['public.file-url', 'public.png']),
      hasImage: vi.fn(() => true),
      getImageBinary,
    });

    const media = await readClipboardMedia({
      platform: 'darwin',
      clipboard: clip,
      runCommand: noMacOsPaths,
    });

    expect(media).toBeNull();
    expect(getImageBinary).not.toHaveBeenCalled();
  });

  it('rejects pasted videos larger than 100 MB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const videoPath = resolve(dir, 'too-big.mp4');
      writeFileSync(videoPath, new Uint8Array([0]));
      truncateSync(videoPath, 101 * 1024 * 1024);
      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['public.file-url']),
        hasText: vi.fn(() => true),
        getText: vi.fn(async () => pathToFileURL(videoPath).toString()),
      });

      await expect(
        readClipboardMedia({
          platform: 'darwin',
          clipboard: clip,
          runCommand: noMacOsPaths,
        }),
      ).rejects.toThrow(ClipboardMediaError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readClipboardMedia on Linux/WSL', () => {
  // WSLg bridges Windows clipboard images into the Wayland clipboard as
  // image/bmp only, which the image pipeline cannot decode.
  function wslgBmpOnlyClipboard(clipTmp: { path: string }) {
    return vi.fn((command: string, args: string[]) => {
      if (command === 'wl-paste' && args.includes('--list-types')) {
        return { stdout: Buffer.from('image/bmp\n'), ok: true };
      }
      if (command === 'wl-paste') {
        return { stdout: Buffer.from([0x42, 0x4d, 0x00]), ok: true };
      }
      if (command === 'xclip') return { stdout: Buffer.alloc(0), ok: false };
      if (command === 'wslpath') {
        clipTmp.path = args[1] ?? '';
        return { stdout: Buffer.from('C:\\Temp\\kimi-wsl-clip-test.png\n'), ok: true };
      }
      if (command === 'powershell.exe') {
        writeFileSync(clipTmp.path, png(3, 2));
        return { stdout: Buffer.from('ok\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });
  }

  it('skips undecodable image/bmp and falls through to the WSL PowerShell fallback', async () => {
    const clipTmp = { path: '' };
    const runCommand = wslgBmpOnlyClipboard(clipTmp);

    const media = await readClipboardMedia({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', WAYLAND_DISPLAY: 'wayland-0' },
      clipboard: null,
      runCommand,
    });

    expect(media).toEqual({ kind: 'image', bytes: png(3, 2), mimeType: 'image/png' });

    // The BMP payload must never be read, and the PowerShell fallback must
    // receive the temp path embedded in the script (env vars do not cross
    // the WSL boundary unless listed in WSLENV).
    const calls = runCommand.mock.calls;
    expect(
      calls.some((c) => c[0] === 'wl-paste' && (c[1] as string[]).includes('--type')),
    ).toBe(false);
    const psCall = calls.find((c) => c[0] === 'powershell.exe');
    expect(psCall?.[1]?.join(' ')).toContain("$path = 'C:\\Temp\\kimi-wsl-clip-test.png'");
  });

  it('returns null for a BMP-only clipboard when not on WSL', async () => {
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'wl-paste' && args.includes('--list-types')) {
        return { stdout: Buffer.from('image/bmp\n'), ok: true };
      }
      if (command === 'wl-paste') {
        return { stdout: Buffer.from([0x42, 0x4d, 0x00]), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });

    const media = await readClipboardMedia({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      clipboard: null,
      runCommand,
    });

    expect(media).toBeNull();
    expect(
      runCommand.mock.calls.some((c) => c[0] === 'wl-paste' && (c[1] as string[]).includes('--type')),
    ).toBe(false);
  });
});
