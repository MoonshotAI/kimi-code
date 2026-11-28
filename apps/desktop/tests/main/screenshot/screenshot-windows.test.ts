import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { candidatesByDisplay, fakeCandidatesByDisplay, listScreenshotWindows } from '../../../src/main/screenshot/screenshot-windows';
import type { DisplayLike } from '../../../src/main/screenshot/controller';

const { execFileAsync, dipToScreenRect, warn } = vi.hoisted(() => ({ execFileAsync: vi.fn(), dipToScreenRect: vi.fn((_window, rect) => rect), warn: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execFileAsync }) };
});
vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/desktop' }, screen: { dipToScreenRect } }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { warn } }));

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.resetAllMocks();
});

const displays: DisplayLike[] = [
  { id: 1, bounds: { x: -100, y: 0, width: 100, height: 80 }, scaleFactor: 1 },
  { id: 2, bounds: { x: 0, y: 0, width: 120, height: 90 }, scaleFactor: 2 },
];

describe('screenshot window candidates', () => {
  it('clips physical windows per monitor before converting mixed DPI coordinates', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const mixed = [
      { id: 1, bounds: { x: -200, y: -50, width: 200, height: 150 }, scaleFactor: 1.5 },
      { id: 2, bounds: { x: 0, y: 0, width: 200, height: 150 }, scaleFactor: 2 },
    ];
    dipToScreenRect.mockImplementation((_window, rect) => rect.x < 0
      ? { x: -300, y: -75, width: 300, height: 225 }
      : { x: 0, y: 0, width: 400, height: 300 });
    try {
      const result = candidatesByDisplay({ units: 'pixels', windows: [
        { id: 'crossing', x: -150, y: 30, width: 250, height: 90 },
        { id: 'back', x: -300, y: -75, width: 700, height: 375 },
      ] }, mixed);
      expect(result.get('1')).toEqual([
        { id: 'crossing', x: 100, y: 70, width: 100, height: 60 },
        { id: 'back', x: 0, y: 0, width: 200, height: 150 },
      ]);
      expect(result.get('2')).toEqual([
        { id: 'crossing', x: 0, y: 15, width: 50, height: 45 },
        { id: 'back', x: 0, y: 0, width: 200, height: 150 },
      ]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      dipToScreenRect.mockImplementation((_window, rect) => rect);
    }
  });

  it('enumerates Windows candidates without opening a console', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      execFileAsync.mockResolvedValue({ stdout: '{"units":"pixels","windows":[]}' });
      await listScreenshotWindows(displays, ['9001', '9002']);
      expect(execFileAsync).toHaveBeenCalledWith(
        join('/desktop', 'native', 'screenshot-window-list', 'dist', 'screenshot-window-list.exe'),
        ['9001', '9002'],
        expect.objectContaining({ windowsHide: true, timeout: 1_000 }),
      );
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it.each(['darwin', 'win32'])('excludes only the supplied overlay window IDs on %s without showing a console', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    execFileAsync.mockResolvedValue({ stdout: JSON.stringify({ units: 'points', windows: [{ id: 'ordinary-app-window', x: 0, y: 0, width: 80, height: 60 }] }) });
    const result = await listScreenshotWindows(displays, ['9001', '9002']);
    expect(execFileAsync).toHaveBeenCalledWith(join('/desktop', 'native', 'screenshot-window-list', 'dist', platform === 'win32' ? 'screenshot-window-list.exe' : 'screenshot-window-list'), ['9001', '9002'], expect.objectContaining({ timeout: 1_000, windowsHide: true }));
    expect(result.get('2')).toEqual([{ id: 'ordinary-app-window', x: 0, y: 0, width: 80, height: 60 }]);
  });

  it('keeps manual capture available and logs native detection failures', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const failure = new Error('native helper timeout');
    execFileAsync.mockRejectedValue(failure);
    expect(await listScreenshotWindows(displays)).toEqual(new Map());
    expect(warn).toHaveBeenCalledWith('[screenshot] window detection unavailable: native helper timeout');
  });

  it('rejects malformed native output without supplying candidates', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    execFileAsync.mockResolvedValue({ stdout: 'not json' });
    expect(await listScreenshotWindows(displays)).toEqual(new Map());
  });

  it('splits a spanning window using each Windows display scale, not the scales at its two corners', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const mixed: DisplayLike[] = [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 2 },
    ];
    dipToScreenRect.mockReturnValueOnce(mixed[0]!.bounds).mockReturnValueOnce({ x: 1920, y: 0, width: 2560, height: 1440 });
    const result = candidatesByDisplay({ units: 'pixels', windows: [{ id: 'spanning', x: 1800, y: 200, width: 400, height: 400 }] }, mixed);
    expect(result.get('1')).toEqual([{ id: 'spanning', x: 1800, y: 200, width: 120, height: 400 }]);
    expect(result.get('2')).toEqual([{ id: 'spanning', x: 0, y: 100, width: 140, height: 200 }]);
    expect(dipToScreenRect.mock.calls).toEqual(mixed.map((display) => [null, display.bounds]));
  });

  it('converts Windows candidates with the placed monitor rectangle at fractional scaling', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const scale = 2.924999952316284;
    const display: DisplayLike = { id: 1, bounds: { x: -1970, y: 0, width: 1970, height: 1108 }, scaleFactor: scale };
    dipToScreenRect.mockReturnValue({ x: -5760, y: 0, width: 5763, height: 3241 });
    const result = candidatesByDisplay(
      { units: 'pixels', windows: [{ id: 'right-half', x: -2880, y: 0, width: 2880, height: 3240 }] },
      [display],
      new Map([['1', { x: -5760, y: 0, width: 5760, height: 3240 }]]),
    );
    expect(result.get('1')).toEqual([{
      id: 'right-half',
      x: expect.closeTo(2880 / scale, 9),
      y: 0,
      width: expect.closeTo(2880 / scale, 9),
      height: expect.closeTo(3240 / scale, 9),
    }]);
    expect(dipToScreenRect).not.toHaveBeenCalled();
  });

  it.each([1.25, 1.5, 2])('handles negative display origins and %s scaling while preserving window order', (scale) => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const display = { id: 3, bounds: { x: -800, y: -600, width: 800, height: 600 }, scaleFactor: scale };
    const physical = { x: -800 * scale, y: -600 * scale, width: 800 * scale, height: 600 * scale };
    dipToScreenRect.mockReturnValue(physical);
    const result = candidatesByDisplay({ units: 'pixels', windows: [
      { id: 'front', x: physical.x + 20 * scale, y: physical.y + 30 * scale, width: 100 * scale, height: 200 * scale },
      { id: 'back', x: physical.x - 20 * scale, y: physical.y - 30 * scale, width: 900 * scale, height: 700 * scale },
      { id: 'tiny', x: physical.x, y: physical.y, width: 7 * scale, height: 10 * scale },
    ] }, [display]);
    expect(result.get('3')).toEqual([
      { id: 'front', x: 20, y: 30, width: 100, height: 200 },
      { id: 'back', x: 0, y: 0, width: 800, height: 600 },
    ]);
  });

  it('splits windows across displays and preserves native z-order', () => {
    const result = candidatesByDisplay({
      units: 'points',
      windows: [
        { id: 'front', x: -20, y: 10, width: 70, height: 60 },
        { id: 'back', x: -80, y: 20, width: 160, height: 50 },
        { id: 'too-small', x: 110, y: 0, width: 4, height: 4 },
      ],
    }, displays);

    expect(result.get('1')).toEqual([
      { id: 'front', x: 80, y: 10, width: 20, height: 60 },
      { id: 'back', x: 20, y: 20, width: 80, height: 50 },
    ]);
    expect(result.get('2')).toEqual([
      { id: 'front', x: 0, y: 10, width: 50, height: 60 },
      { id: 'back', x: 0, y: 20, width: 80, height: 50 },
    ]);
  });

  it('generates bounded fake candidates for deterministic visual tests', () => {
    const result = fakeCandidatesByDisplay(displays);
    for (const display of displays) {
      const candidates = result.get(String(display.id)) ?? [];
      expect(candidates).toHaveLength(2);
      for (const candidate of candidates) {
        expect(candidate.x).toBeGreaterThanOrEqual(0);
        expect(candidate.y).toBeGreaterThanOrEqual(0);
        expect(candidate.x + candidate.width).toBeLessThanOrEqual(display.bounds.width);
        expect(candidate.y + candidate.height).toBeLessThanOrEqual(display.bounds.height);
      }
    }
  });
});
