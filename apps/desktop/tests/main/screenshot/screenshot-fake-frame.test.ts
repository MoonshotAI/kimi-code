import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { gradientFramePng } from '../../../src/main/screenshot/screenshot-fake-frame';

describe('gradientFramePng', () => {
  it('emits a well-formed PNG with the requested dimensions', () => {
    const png = gradientFramePng(320, 200, [10, 20, 30], [200, 210, 220]);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(200);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(2);
  });

  it('encodes every scanline so the crop math sees real pixels', () => {
    const width = 64;
    const height = 48;
    const png = gradientFramePng(width, height, [0, 0, 0], [255, 255, 255]);
    const idatStart = png.indexOf(Buffer.from('IDAT'));
    const idatLength = png.readUInt32BE(idatStart - 4);
    const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLength));
    expect(raw.length).toBe((width * 3 + 1) * height);
    expect(raw[1]).toBe(0);
    expect(raw[raw.length - 3]).toBe(255);
  });

  it('handles a single-pixel frame', () => {
    const png = gradientFramePng(1, 1, [7, 8, 9], [7, 8, 9]);
    const idatStart = png.indexOf(Buffer.from('IDAT'));
    const idatLength = png.readUInt32BE(idatStart - 4);
    const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLength));
    expect([...raw]).toEqual([0, 7, 8, 9]);
  });
});
