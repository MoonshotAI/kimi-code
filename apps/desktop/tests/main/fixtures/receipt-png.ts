import { deflateSync } from 'node:zlib';

type Pixel = (x: number, y: number) => [number, number, number];

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function predict(filter: number, left: number, up: number, corner: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  if (filter === 4) {
    const toLeft = Math.abs(up - corner), toUp = Math.abs(left - corner), toCorner = Math.abs(left + up - 2 * corner);
    return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
  }
  return 0;
}

export function encodePng(width: number, height: number, pixel: Pixel, options: { alpha?: boolean; filter?: (row: number) => number; interlace?: boolean } = {}): Buffer {
  const channels = options.alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const current = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = pixel(x, y);
      current.set(options.alpha ? [red, green, blue, 255] : [red, green, blue], x * channels);
    }
    const filter = options.filter?.(y) ?? 2;
    const out = (stride + 1) * y;
    raw[out] = filter;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels]! : 0;
      const corner = i >= channels ? previous[i - channels]! : 0;
      raw[out + 1 + i] = (current[i]! - predict(filter, left, previous[i]!, corner)) & 0xff;
    }
    previous = current;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, options.alpha ? 6 : 2, 0, 0, options.interlace ? 1 : 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
