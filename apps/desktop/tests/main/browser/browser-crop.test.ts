import { afterEach, expect, it, vi } from 'vitest';
import { retainBrowserScreenshot, cropBrowserScreenshot } from '../../../src/main/browser/browser-crop';
import { formatBrowserToolResult } from '../../../src/main/browser/browser-tool-output';
import { asBrowserRunRequest } from '../../../src/shared/browser-automation';

const mocks = vi.hoisted(() => ({ crop: vi.fn(), contentsId: 1 }));
vi.mock('../../../src/main/browser/browser-view', () => ({ getBrowserPage: () => ({ webContents: { id: mocks.contentsId } }) }));
vi.mock('electron', () => {
  const image = (width: number, height: number): any => ({
    getSize: () => ({ width, height }), isEmpty: () => false, toPNG: () => Buffer.from('cropped-image'),
    resize: (size: { width: number; height: number }) => image(size.width, size.height),
    crop: (region: { x: number; y: number; width: number; height: number }) => { mocks.crop(region); return image(region.width, region.height); },
  });
  return { nativeImage: { createFromBuffer: () => image(2000, 1000) } };
});
const request = { protocol: 'kimi.browser/1.0.0' as const, operation: 'page.visual.crop' as const, tabId: 'tab', snapshotId: 'visual-1', region: { x: 100, y: 50, width: 200, height: 100 } };
afterEach(() => { vi.useRealTimers(); mocks.crop.mockClear(); mocks.contentsId = 1; });

it('crops the retained original pixels and returns an exact mapping without a clickable snapshot ID', () => {
  retainBrowserScreenshot('browser', 1, 'visual-1', Buffer.from('original'), 1000, 500);
  const result = cropBrowserScreenshot('browser', request);
  expect(mocks.crop).toHaveBeenCalledWith({ x: 200, y: 100, width: 400, height: 200 });
  expect(result).toMatchObject({ sourceSnapshotId: 'visual-1', width: 400, height: 200, region: request.region });
  expect(result).not.toHaveProperty('snapshotId');
  expect(formatBrowserToolResult({ ok: true, operation: request.operation, crop: result })).not.toContain(result.data);
});

it('rejects out-of-bounds regions, cross-tab reads and replaced views', () => {
  retainBrowserScreenshot('browser', 1, 'visual-1', Buffer.from('original'), 1000, 500);
  expect(() => cropBrowserScreenshot('browser', { ...request, region: { x: 900, y: 0, width: 200, height: 100 } })).toThrow('entirely inside');
  expect(() => cropBrowserScreenshot('other', request)).toThrow('unavailable');
  mocks.contentsId = 2;
  expect(() => cropBrowserScreenshot('browser', request)).toThrow('unavailable');
  expect(asBrowserRunRequest({ ...request, region: { ...request.region, width: 0 } })).toBeNull();
});

it('expires originals without falling back to a fresh screenshot', () => {
  vi.useFakeTimers();
  retainBrowserScreenshot('browser', 1, 'visual-1', Buffer.from('original'), 1000, 500);
  vi.advanceTimersByTime(60_000);
  expect(() => cropBrowserScreenshot('browser', request)).toThrow('unavailable');
  expect(mocks.crop).not.toHaveBeenCalled();
});

it('does not retain an oversized original', () => {
  expect(retainBrowserScreenshot('browser', 1, 'oversized', Buffer.alloc(32 * 1024 * 1024 + 1), 1000, 500)).toBe(false);
  expect(() => cropBrowserScreenshot('browser', { ...request, snapshotId: 'oversized' })).toThrow('unavailable');
});
