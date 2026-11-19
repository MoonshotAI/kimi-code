import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { encodeScreenshotBitmap, screenshotBitmapFrame } from '../../../src/main/screenshot/screenshot-frame';

describe('screenshotBitmapFrame', () => {
  it.runIf(process.platform === 'win32')('displays BGRA pixels in Chromium and exports their colors, positions and alpha as PNG', async () => {
    const bitmap = Buffer.from([
      0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255,
      29, 19, 9, 255, 16, 32, 64, 128, 0, 0, 0, 0,
    ]);
    const original = Buffer.from(bitmap);
    const directory = await mkdtemp(join(tmpdir(), 'kimi-screenshot-frame-'));
    const file = join(directory, 'frame.bmp');
    try {
      await writeFile(file, screenshotBitmapFrame(bitmap, 3, 2));
      const executable = createRequire(import.meta.url)('electron') as string;
      const fixture = fileURLToPath(new URL('../fixtures/screenshot-frame-decode.cjs', import.meta.url));
      const { stdout } = await promisify(execFile)(executable, [fixture, file], {
        timeout: 15_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      const { png } = JSON.parse(stdout) as { png: string };
      const { data, width, height } = PNG.sync.read(Buffer.from(png.split(',')[1]!, 'base64'));
      expect({ width, height }).toMatchObject({ width: 3, height: 2 });
      expect([...data]).toEqual([
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
        9, 19, 29, 255, 128, 64, 32, 128, 0, 0, 0, 0,
      ]);
      expect(bitmap).toEqual(original);
    } finally {
      await unlink(file).catch(() => {});
      await rmdir(directory);
    }
  }, 20_000);

  it.each([[0, 1], [1, -1], [1.5, 1], [2, 2], [0x80000000, 1]])('rejects invalid dimensions %s × %s', (width, height) => {
    expect(() => screenshotBitmapFrame(Buffer.alloc(4), width, height)).toThrow('invalid-screenshot-bitmap');
  });
});

describe('encodeScreenshotBitmap', () => {
  it('preserves pixel positions and converts Windows BGRA into a lossless PNG', async () => {
    const bitmap = Buffer.from([
      0, 0, 255, 255, 0, 255, 0, 255,
      255, 0, 0, 255, 29, 19, 9, 255,
    ]);
    const png = await encodeScreenshotBitmap(bitmap, 2, 2);
    const { data, width, height } = PNG.sync.read(png);
    expect({ width, height }).toMatchObject({ width: 2, height: 2 });
    expect([...data]).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 9, 19, 29, 255,
    ]);
    expect([...bitmap.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
  });

  it('unpremultiplies translucent pixels and preserves transparency', async () => {
    const png = await encodeScreenshotBitmap(Buffer.from([16, 32, 64, 128, 0, 0, 0, 0]), 2, 1);
    expect([...PNG.sync.read(png).data]).toEqual([128, 64, 32, 128, 0, 0, 0, 0]);
  });

  it.each([[0, 1], [1, -1], [1.5, 1], [2, 2]])('rejects invalid bitmap dimensions %s × %s', async (width, height) => {
    await expect(encodeScreenshotBitmap(Buffer.alloc(4), width, height)).rejects.toThrow('invalid-screenshot-bitmap');
  });
});
