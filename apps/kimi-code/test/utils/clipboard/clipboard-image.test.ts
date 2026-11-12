import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import type { RunCommand } from '#/utils/clipboard/clipboard-common';
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

function wslPowerShellImageRunner(imageBytes: Uint8Array): {
  runCommand: RunCommand;
  getPowerShellEnv: () => NodeJS.ProcessEnv | null;
} {
  let linuxPath: string | null = null;
  let powerShellEnv: NodeJS.ProcessEnv | null = null;
  const runCommand: RunCommand = (command, args, options) => {
    if (command === 'wslpath') {
      const candidate = args[1];
      linuxPath = candidate ?? null;
      return { stdout: Buffer.from('C:\\Users\\example\\clip.png\n'), ok: linuxPath !== null };
    }
    if (command === 'powershell.exe') {
      powerShellEnv = options?.env ?? null;
      if (linuxPath !== null) {
        writeFileSync(linuxPath, imageBytes);
      }
      return { stdout: Buffer.from('ok\n'), ok: true };
    }
    if (command === 'wl-paste' || command === 'xclip') {
      return { stdout: Buffer.alloc(0), ok: false };
    }
    return { stdout: Buffer.alloc(0), ok: false };
  };
  return { runCommand, getPowerShellEnv: () => powerShellEnv };
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

  it('reads a WSL Wayland BMP clipboard through PowerShell when wl-paste exposes only image/bmp', async () => {
    const imageBytes = png(16, 17);
    const { runCommand: runPowerShellImageCommand } = wslPowerShellImageRunner(imageBytes);
    const runCommand: RunCommand = (command, args, options) => {
      if (command === 'wl-paste' && args.includes('--list-types')) {
        return { stdout: Buffer.from('image/bmp\n'), ok: true };
      }
      if (command === 'wl-paste' && args.includes('image/bmp')) {
        return { stdout: Buffer.from([0x42, 0x4d, 0x01]), ok: true };
      }
      return runPowerShellImageCommand(command, args, options);
    };

    const media = await readClipboardMedia({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0' },
      clipboard: null,
      runCommand,
    });

    expect(media).toEqual({ kind: 'image', bytes: imageBytes, mimeType: 'image/png' });
  });

  it('reads a WSL clipboard image through PowerShell when WSLENV needs the image path entry added', async () => {
    const imageBytes = png(8, 9);
    const { runCommand, getPowerShellEnv } = wslPowerShellImageRunner(imageBytes);

    const media = await readClipboardMedia({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu', WSLENV: 'HOME/p:KIMI_EXISTING/u' },
      clipboard: null,
      runCommand,
    });

    expect(media).toEqual({ kind: 'image', bytes: imageBytes, mimeType: 'image/png' });
    expect(getPowerShellEnv()).toMatchObject({
      KIMI_WSL_CLIPBOARD_IMAGE_PATH: 'C:\\Users\\example\\clip.png',
      WSLENV: 'HOME/p:KIMI_EXISTING/u:KIMI_WSL_CLIPBOARD_IMAGE_PATH/w',
    });
  });

  it('reads a WSL clipboard image through PowerShell when WSLENV already has the image path entry once', async () => {
    const imageBytes = png(10, 11);
    const { runCommand, getPowerShellEnv } = wslPowerShellImageRunner(imageBytes);

    const media = await readClipboardMedia({
      platform: 'linux',
      env: {
        WSL_DISTRO_NAME: 'Ubuntu',
        WSLENV: 'HOME/p:KIMI_WSL_CLIPBOARD_IMAGE_PATH/w:KIMI_EXISTING/u',
      },
      clipboard: null,
      runCommand,
    });

    expect(media).toEqual({ kind: 'image', bytes: imageBytes, mimeType: 'image/png' });
    expect(getPowerShellEnv()).toMatchObject({
      KIMI_WSL_CLIPBOARD_IMAGE_PATH: 'C:\\Users\\example\\clip.png',
      WSLENV: 'HOME/p:KIMI_WSL_CLIPBOARD_IMAGE_PATH/w:KIMI_EXISTING/u',
    });
  });

  it('reads a WSL clipboard image through PowerShell when WSLENV has duplicate image path entries, merges flags and adds w', async () => {
    const imageBytes = png(12, 13);
    const { runCommand, getPowerShellEnv } = wslPowerShellImageRunner(imageBytes);

    const media = await readClipboardMedia({
      platform: 'linux',
      env: {
        WSL_DISTRO_NAME: 'Ubuntu',
        WSLENV: 'HOME/p:KIMI_WSL_CLIPBOARD_IMAGE_PATH/u:KIMI_EXISTING/u:KIMI_WSL_CLIPBOARD_IMAGE_PATH/l',
      },
      clipboard: null,
      runCommand,
    });

    expect(media).toEqual({ kind: 'image', bytes: imageBytes, mimeType: 'image/png' });
    expect(getPowerShellEnv()).toMatchObject({
      KIMI_WSL_CLIPBOARD_IMAGE_PATH: 'C:\\Users\\example\\clip.png',
      WSLENV: 'HOME/p:KIMI_WSL_CLIPBOARD_IMAGE_PATH/ulw:KIMI_EXISTING/u',
    });
  });

  it('reads a WSL clipboard image through PowerShell when explicit env omits WSLENV, ignores host WSLENV', async () => {
    const previousWslEnv = process.env['WSLENV'];
    process.env['WSLENV'] = 'HOST_SENTINEL/p';
    try {
      const imageBytes = png(14, 15);
      const { runCommand, getPowerShellEnv } = wslPowerShellImageRunner(imageBytes);

      const media = await readClipboardMedia({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        clipboard: null,
        runCommand,
      });

      expect(media).toEqual({ kind: 'image', bytes: imageBytes, mimeType: 'image/png' });
      expect(getPowerShellEnv()).toMatchObject({
        KIMI_WSL_CLIPBOARD_IMAGE_PATH: 'C:\\Users\\example\\clip.png',
        WSLENV: 'KIMI_WSL_CLIPBOARD_IMAGE_PATH/w',
      });
    } finally {
      if (previousWslEnv === undefined) {
        delete process.env['WSLENV'];
      } else {
        process.env['WSLENV'] = previousWslEnv;
      }
    }
  });
});
