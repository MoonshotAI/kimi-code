import { describe, expect, it } from 'vitest';
import { cropReceiptBitmap } from '../../../src/main/browser/browser-receipt-image';
import { encodePng } from '../fixtures/receipt-png';

const gradient = (x: number, y: number): [number, number, number] => [(x * 7 + y) & 0xff, (x + y * 5) & 0xff, (x * 3 + y * 11) & 0xff];

function job(png: Buffer, viewport: { width: number; height: number }, crop: { x: number; y: number; width: number; height: number }, maxWidth = 720) {
  return { data: png.toString('base64'), viewport, crop, maxWidth };
}

function pixelAt(bitmap: { width: number; bgra: Uint8Array }, x: number, y: number): [number, number, number, number] {
  const at = (y * bitmap.width + x) * 4;
  return [bitmap.bgra[at + 2]!, bitmap.bgra[at + 1]!, bitmap.bgra[at]!, bitmap.bgra[at + 3]!];
}

describe('receipt crop from a full viewport screenshot', () => {
  it.each([0, 1, 2, 3, 4])('decodes rows written with PNG filter %i', (filter) => {
    const png = encodePng(40, 30, gradient, { filter: () => filter });
    const bitmap = cropReceiptBitmap(job(png, { width: 20, height: 15 }, { x: 3, y: 4, width: 10, height: 6 }))!;
    expect(bitmap).toMatchObject({ width: 20, height: 12 });
    for (const [x, y] of [[0, 0], [7, 3], [19, 11]] as const) expect(pixelAt(bitmap, x, y)).toEqual([...gradient(6 + x, 8 + y), 255]);
  });

  it('decodes rows that mix filters and screenshots with an alpha channel', () => {
    const png = encodePng(40, 30, gradient, { alpha: true, filter: row => row % 5 });
    const bitmap = cropReceiptBitmap(job(png, { width: 40, height: 30 }, { x: 10, y: 20, width: 30, height: 10 }))!;
    expect(bitmap).toMatchObject({ width: 30, height: 10 });
    expect(pixelAt(bitmap, 29, 9)).toEqual([...gradient(39, 29), 255]);
  });

  it('maps the crop through the pixel ratio of the screenshot, including fractional scaling', () => {
    const inside = (x: number, y: number) => x >= 126 && x < 727 && y >= 352 && y < 728;
    const png = encodePng(1920, 1080, (x, y) => inside(x, y) ? [0, 200, 0] : [255, 0, 0]);
    const bitmap = cropReceiptBitmap(job(png, { width: 1536, height: 864 }, { x: 101.5, y: 282, width: 480, height: 300 }))!;
    expect(bitmap).toMatchObject({ width: 601, height: 376 });
    for (const [x, y] of [[0, 0], [600, 375], [300, 188]] as const) expect(pixelAt(bitmap, x, y)).toEqual([0, 200, 0, 255]);
  });

  it('downscales dense crops to the output width by averaging, and never enlarges small ones', () => {
    const png = encodePng(960, 600, x => (x % 2 === 0 ? [0, 0, 0] : [200, 100, 50]));
    const dense = cropReceiptBitmap(job(png, { width: 320, height: 200 }, { x: 0, y: 0, width: 320, height: 200 }, 480))!;
    expect(dense).toMatchObject({ width: 480, height: 300 });
    expect(pixelAt(dense, 100, 100)).toEqual([100, 50, 25, 255]);
    const plain = cropReceiptBitmap(job(png, { width: 960, height: 600 }, { x: 0, y: 0, width: 480, height: 300 }))!;
    expect(plain).toMatchObject({ width: 480, height: 300 });
  });

  it('gives up on screenshots it cannot map or decode', () => {
    const png = encodePng(64, 40, gradient);
    const crop = { x: 0, y: 0, width: 10, height: 10 };
    expect(cropReceiptBitmap(job(png, { width: 32, height: 16 }, crop))).toBeNull();
    expect(cropReceiptBitmap(job(Buffer.from('not a png'), { width: 32, height: 20 }, crop))).toBeNull();
    expect(cropReceiptBitmap(job(encodePng(64, 40, gradient, { interlace: true }), { width: 32, height: 20 }, crop))).toBeNull();
    expect(cropReceiptBitmap(job(encodePng(64, 40, gradient, { filter: () => 9 }), { width: 32, height: 20 }, crop))).toBeNull();
    expect(cropReceiptBitmap(job(png, { width: 32, height: 20 }, { x: 40, y: 0, width: 10, height: 10 }))).toBeNull();
  });
});
