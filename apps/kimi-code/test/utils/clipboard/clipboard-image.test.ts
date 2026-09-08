import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
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

function heic(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x00, 0x00, 0x00, 0x18], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x68, 0x65, 0x69, 0x63], 8);
  bytes.set([0x68, 0x65, 0x69, 0x63], 16);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

type CommandResult = { stdout: Buffer; ok: boolean };

function macCommands(options: {
  readonly paths: string;
  readonly sips?: (args: string[]) => CommandResult;
}): { run: (command: string, args: string[]) => CommandResult; calls: string[][] } {
  const calls: string[][] = [];
  const run = (command: string, args: string[]): CommandResult => {
    calls.push([command, ...args]);
    if (command === 'osascript') return { stdout: Buffer.from(options.paths), ok: true };
    if (command === 'sips' && options.sips !== undefined) return options.sips(args);
    return { stdout: Buffer.alloc(0), ok: false };
  };
  return { run, calls };
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

  it('converts a copied HEIC file through sips on macOS and pastes the JPEG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const heicPath = join(dir, 'IMG_0001.HEIC');
      writeFileSync(heicPath, heic());
      const converted = jpeg(6, 4);
      const commands = macCommands({
        paths: `${heicPath}\n`,
        sips: (args) => {
          writeFileSync(args[args.indexOf('--out') + 1]!, converted);
          return { stdout: Buffer.alloc(0), ok: true };
        },
      });
      const clip = fakeClipboard({ availableFormats: vi.fn(() => ['public.file-url']) });

      const media = await readClipboardMedia({
        platform: 'darwin',
        clipboard: clip,
        runCommand: commands.run,
      });

      expect(media).toEqual({ kind: 'image', bytes: converted, mimeType: 'image/jpeg' });
      const sips = commands.calls.find((call) => call[0] === 'sips');
      expect(sips).toBeDefined();
      expect(sips!.slice(1, 7)).toEqual(['-s', 'format', 'jpeg', '-s', 'formatOptions', '90']);
      expect(sips![7]).toBe(heicPath);
      expect(sips![8]).toBe('--out');
      expect(sips![9]!.endsWith('.jpg')).toBe(true);
      expect(existsSync(sips![9]!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('declines the paste when sips cannot convert the copied HEIC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const heicPath = join(dir, 'broken.heic');
      writeFileSync(heicPath, heic());
      const commands = macCommands({
        paths: `${heicPath}\n`,
        sips: () => ({ stdout: Buffer.alloc(0), ok: false }),
      });
      const clip = fakeClipboard({ availableFormats: vi.fn(() => ['public.file-url']) });

      const media = await readClipboardMedia({
        platform: 'darwin',
        clipboard: clip,
        runCommand: commands.run,
      });

      expect(media).toBeNull();
      expect(commands.calls.some((call) => call[0] === 'sips')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not try to convert a copied HEIC file off macOS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const heicPath = join(dir, 'IMG_0002.heic');
      writeFileSync(heicPath, heic());
      const runCommand = vi.fn(() => ({ stdout: Buffer.alloc(0), ok: false }));
      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['text/uri-list']),
        hasText: vi.fn(() => true),
        getText: vi.fn(async () => pathToFileURL(heicPath).toString()),
      });

      const media = await readClipboardMedia({ platform: 'win32', clipboard: clip, runCommand });

      expect(media).toBeNull();
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
