import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';

import { compressImage, cropImage, sniffImageDimensions } from '#/image/index';

const ONE_PIXEL_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

async function png(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0x336699ff });
  return new Uint8Array(await image.getBuffer('image/png'));
}

describe('image intake', () => {
  it('compresses oversized images, passes through small or unsupported ones and crops regions', async () => {
    const wide = await png(3000, 20);
    expect(sniffImageDimensions(wide)).toEqual({ width: 3000, height: 20 });
    const compressed = await compressImage(wide, 'image/png');
    expect(compressed).toMatchObject({ outcome: 'compressed', changed: true, width: 2000, originalWidth: 3000 });
    expect(sniffImageDimensions(compressed.data)?.width).toBe(2000);

    const small = await png(10, 10);
    expect((await compressImage(small, 'image/png')).outcome).toBe('passthrough_fast');
    expect((await compressImage(small, 'image/gif')).outcome).toBe('passthrough_unsupported');

    const cropped = await cropImage(wide, 'image/png', { x: 10, y: 0, width: 50, height: 5 });
    expect(cropped).toMatchObject({ ok: true, width: 50, height: 5, region: { x: 10, y: 0, width: 50, height: 5 } });
    expect(await cropImage(wide, 'image/png', { x: 5000, y: 0, width: 1, height: 1 })).toMatchObject({
      ok: false,
      errorKind: 'out_of_bounds',
    });
    expect(await cropImage(ONE_PIXEL_WEBP, 'image/webp', { x: 0, y: 0, width: 1, height: 1 })).toMatchObject({
      ok: true,
      width: 1,
      height: 1,
      mimeType: 'image/png',
    });
  });
});
