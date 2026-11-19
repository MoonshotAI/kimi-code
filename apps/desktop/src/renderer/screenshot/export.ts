import type { ScreenshotEditor } from './editor';
import type { Rect, ScreenshotFrame } from './types';

export async function exportScreenshot(frame: ScreenshotFrame, editor: ScreenshotEditor, selection: Rect): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const width = Math.max(1, Math.round(selection.width));
  const height = Math.max(1, Math.round(selection.height));
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const ctx = output.getContext('2d');
  if (ctx === null) throw new Error('canvas-context-unavailable');
  ctx.drawImage(frame, selection.x, selection.y, width, height, 0, 0, width, height);
  ctx.drawImage(editor.annotationCanvas(selection), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    output.toBlob((value) => value === null ? reject(new Error('png-export-failed')) : resolve(value), 'image/png');
  });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}
