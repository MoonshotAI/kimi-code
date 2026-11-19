import type { NativeImage } from 'electron';
import { IMAGE_BYTE_BUDGET, resolveMaxImageEdgePx } from '@moonshot-ai/agent-core-v2/agent/media/image-compress';
import { BrowserReadError } from './browser-read-cache';

export function encodeBrowserImage(original: NativeImage): { data: Buffer; width: number; height: number } {
  let image = original;
  if (image.isEmpty()) throw new BrowserReadError('PAGE_NOT_READY', 'Browser produced an empty screenshot.');
  let data = image.toPNG();
  let size = image.getSize();
  const maxEdge = resolveMaxImageEdgePx();
  while (Math.max(size.width, size.height) > maxEdge || data.length > IMAGE_BYTE_BUDGET) {
    if (size.width === 1 && size.height === 1) throw new BrowserReadError('OUTPUT_LIMIT', 'Screenshot exceeds the image budget.');
    const scale = Math.min(maxEdge / Math.max(size.width, size.height), data.length > IMAGE_BYTE_BUDGET ? 0.8 : 1);
    image = image.resize({ width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)), quality: 'best' });
    data = image.toPNG(); size = image.getSize();
  }
  return { data, ...size };
}
