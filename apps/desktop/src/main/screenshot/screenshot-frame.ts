import { promisify } from 'node:util';
import { crc32, deflate } from 'node:zlib';

const compress = promisify(deflate);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function screenshotBitmapFrame(bitmap: Buffer, width: number, height: number): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 0x7fffffff || height > 0x7fffffff || bitmap.length !== width * height * 4
    || bitmap.length > 0xffffffff - 122) throw new Error('invalid-screenshot-bitmap');
  const frame = Buffer.allocUnsafe(122 + bitmap.length);
  frame.fill(0, 0, 122);
  frame.write('BM');
  frame.writeUInt32LE(frame.length, 2);
  frame.writeUInt32LE(122, 10);
  frame.writeUInt32LE(108, 14);
  frame.writeInt32LE(width, 18);
  frame.writeInt32LE(-height, 22);
  frame.writeUInt16LE(1, 26);
  frame.writeUInt16LE(32, 28);
  frame.writeUInt32LE(3, 30);
  frame.writeUInt32LE(bitmap.length, 34);
  frame.writeUInt32LE(0x00ff0000, 54);
  frame.writeUInt32LE(0x0000ff00, 58);
  frame.writeUInt32LE(0x000000ff, 62);
  frame.writeUInt32LE(0xff000000, 66);
  frame.writeUInt32LE(0x73524742, 70);
  bitmap.copy(frame, 122);
  for (let offset = 122; offset < frame.length; offset += 4) {
    const alpha = frame[offset + 3]!;
    if (alpha === 255) continue;
    const factor = alpha === 0 ? 0 : 255 / alpha;
    for (let channel = 0; channel < 3; channel++) {
      frame[offset + channel] = Math.min(255, Math.round(frame[offset + channel]! * factor));
    }
  }
  return frame;
}

export function screenshotRgbaFrame(rgba: Buffer, width: number, height: number): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 0x7fffffff || height > 0x7fffffff || rgba.length !== width * height * 4
    || rgba.length > 0xffffffff - 122) throw new Error('invalid-screenshot-bitmap');
  const frame = Buffer.allocUnsafe(122 + rgba.length);
  frame.fill(0, 0, 122);
  frame.write('BM');
  frame.writeUInt32LE(frame.length, 2);
  frame.writeUInt32LE(122, 10);
  frame.writeUInt32LE(108, 14);
  frame.writeInt32LE(width, 18);
  frame.writeInt32LE(-height, 22);
  frame.writeUInt16LE(1, 26);
  frame.writeUInt16LE(32, 28);
  frame.writeUInt32LE(3, 30);
  frame.writeUInt32LE(rgba.length, 34);
  frame.writeUInt32LE(0x000000ff, 54);
  frame.writeUInt32LE(0x0000ff00, 58);
  frame.writeUInt32LE(0x00ff0000, 62);
  frame.writeUInt32LE(0xff000000, 66);
  frame.writeUInt32LE(0x73524742, 70);
  rgba.copy(frame, 122);
  return frame;
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4, 'ascii');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(data, crc32(header.subarray(4))));
  return Buffer.concat([header, data, checksum]);
}

export async function encodeScreenshotBitmap(bitmap: Buffer, width: number, height: number): Promise<Buffer> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || bitmap.length !== width * height * 4) throw new Error('invalid-screenshot-bitmap');
  const stride = width * 4;
  const rows = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    let target = y * (stride + 1);
    rows[target++] = 0;
    for (let source = y * stride; source < (y + 1) * stride; source += 4) {
      const alpha = bitmap[source + 3]!;
      if (alpha === 255) {
        rows[target++] = bitmap[source + 2]!;
        rows[target++] = bitmap[source + 1]!;
        rows[target++] = bitmap[source]!;
      } else {
        const factor = alpha === 0 ? 0 : 255 / alpha;
        rows[target++] = Math.min(255, Math.round(bitmap[source + 2]! * factor));
        rows[target++] = Math.min(255, Math.round(bitmap[source + 1]! * factor));
        rows[target++] = Math.min(255, Math.round(bitmap[source]! * factor));
      }
      rows[target++] = alpha;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const compressed = await compress(rows, { level: 1 });
  return Buffer.concat([signature, chunk('IHDR', header), chunk('sRGB', Buffer.from([0])), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}
