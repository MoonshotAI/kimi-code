import { nativeImage } from 'electron';
import { BrowserReadCache, BrowserReadError } from './browser-read-cache';
import { encodeBrowserImage } from './browser-image';
import { getBrowserPage } from './browser-view';
import { BROWSER_LOCAL_FILE_REFUSAL, type BrowserVisualCrop, type BrowserRunRequest } from '../../shared/browser-automation';

const budget = 32 * 1024 * 1024;
const captures = new BrowserReadCache<{ data: Buffer; width: number; height: number; capturedAt: number }>(budget, 60_000);

export function retainBrowserScreenshot(browserId: string, contentsId: number, snapshotId: string, data: Buffer, width: number, height: number): boolean {
  if (data.length > budget) return false;
  captures.put(`${browserId}:${contentsId}`, { data, width, height, capturedAt: Date.now() }, data.length, snapshotId);
  return true;
}

export function cropBrowserScreenshot(browserId: string, request: Extract<BrowserRunRequest, { operation: 'page.visual.crop' }>): BrowserVisualCrop {
  const page = getBrowserPage(browserId);
  if (!page) throw new BrowserReadError('PAGE_NOT_READY', 'Browser page is unavailable.');
  if (page.localFile) throw new BrowserReadError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
  const capture = captures.get(`${browserId}:${page.webContents.id}`, request.snapshotId);
  const { x, y, width, height } = request.region;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > capture.width || y + height > capture.height) {
    throw new BrowserReadError('COORDINATE_OUT_OF_BOUNDS', 'Crop must be entirely inside the source screenshot.');
  }
  const original = nativeImage.createFromBuffer(capture.data);
  const size = original.getSize();
  const scaleX = size.width / capture.width;
  const scaleY = size.height / capture.height;
  const left = Math.floor(x * scaleX);
  const top = Math.floor(y * scaleY);
  const right = Math.min(size.width, Math.ceil((x + width) * scaleX));
  const bottom = Math.min(size.height, Math.ceil((y + height) * scaleY));
  const cropped = encodeBrowserImage(original.crop({ x: left, y: top, width: right - left, height: bottom - top }));
  return { sourceSnapshotId: request.snapshotId, capturedAt: capture.capturedAt, mimeType: 'image/png', data: cropped.data.toString('base64'),
    width: cropped.width, height: cropped.height,
    region: { x: left / scaleX, y: top / scaleY, width: (right - left) / scaleX, height: (bottom - top) / scaleY } };
}
