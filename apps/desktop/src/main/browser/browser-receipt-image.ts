import { inflateSync } from 'node:zlib';

export interface ReceiptRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReceiptCropJob {
  data: string;
  viewport: { width: number; height: number };
  crop: ReceiptRect;
  maxWidth: number;
}

export interface ReceiptBitmap {
  width: number;
  height: number;
  bgra: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface PngImage {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

function readPng(data: Buffer): PngImage | null {
  if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0, height = 0, channels = 0;
  const parts: Buffer[] = [];
  for (let offset = 8; offset + 8 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return null;
    if (type === 'IHDR') {
      if (length < 13 || body[8] !== 8 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return null;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 2 ? 3 : body[9] === 6 ? 4 : 0;
      if (channels === 0) return null;
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || parts.length === 0) return null;
  const pixels = inflateSync(Buffer.concat(parts));
  return pixels.length >= (width * channels + 1) * height ? { width, height, channels, pixels } : null;
}

function unfilter(image: PngImage, rows: number): boolean {
  const { pixels, channels } = image;
  const stride = image.width * channels + 1;
  for (let y = 0; y < rows; y++) {
    const row = y * stride + 1;
    const end = row + stride - 1;
    const filter = pixels[row - 1];
    const up = y > 0 ? -stride : 0;
    if (filter === 0) continue;
    if (filter === 1) {
      for (let i = row + channels; i < end; i++) pixels[i] = (pixels[i]! + pixels[i - channels]!) & 0xff;
    } else if (filter === 2) {
      if (y > 0) for (let i = row; i < end; i++) pixels[i] = (pixels[i]! + pixels[i + up]!) & 0xff;
    } else if (filter === 3) {
      for (let i = row; i < end; i++) {
        const left = i - channels >= row ? pixels[i - channels]! : 0;
        const above = y > 0 ? pixels[i + up]! : 0;
        pixels[i] = (pixels[i]! + ((left + above) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = row; i < end; i++) {
        const hasLeft = i - channels >= row;
        const left = hasLeft ? pixels[i - channels]! : 0;
        const above = y > 0 ? pixels[i + up]! : 0;
        const corner = hasLeft && y > 0 ? pixels[i + up - channels]! : 0;
        const toLeft = Math.abs(above - corner), toUp = Math.abs(left - corner), toCorner = Math.abs(left + above - 2 * corner);
        pixels[i] = (pixels[i]! + (toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? above : corner)) & 0xff;
      }
    } else {
      return false;
    }
  }
  return true;
}

function spans(source: number, target: number): Array<Array<[number, number]>> {
  const scale = source / target;
  return Array.from({ length: target }, (_, index) => {
    const start = index * scale, end = start + scale;
    const taps: Array<[number, number]> = [];
    for (let at = Math.floor(start); at < Math.min(source, Math.ceil(end)); at++) {
      taps.push([at, (Math.min(end, at + 1) - Math.max(start, at)) / scale]);
    }
    return taps;
  });
}

export function cropReceiptBitmap(job: ReceiptCropJob): ReceiptBitmap | null {
  const image = readPng(Buffer.from(job.data, 'base64'));
  if (image === null) return null;
  const scaleX = image.width / job.viewport.width;
  const scaleY = image.height / job.viewport.height;
  if (!(scaleX > 0) || Math.abs(scaleX / scaleY - 1) > 0.02) return null;
  const { crop } = job;
  const left = Math.max(0, Math.floor(crop.x * scaleX));
  const top = Math.max(0, Math.floor(crop.y * scaleY));
  const right = Math.min(image.width, Math.ceil((crop.x + crop.width) * scaleX));
  const bottom = Math.min(image.height, Math.ceil((crop.y + crop.height) * scaleY));
  if (right <= left || bottom <= top || !unfilter(image, bottom)) return null;
  const sourceWidth = right - left, sourceHeight = bottom - top;
  const width = Math.min(job.maxWidth, sourceWidth);
  const height = width === sourceWidth ? sourceHeight : Math.max(1, Math.round(sourceHeight * width / sourceWidth));
  const { pixels, channels } = image;
  const stride = image.width * channels + 1;
  const columns = spans(sourceWidth, width);
  const rows = spans(sourceHeight, height);
  const horizontal = new Float32Array(sourceHeight * width * 3);
  for (let y = 0; y < sourceHeight; y++) {
    const row = (top + y) * stride + 1;
    for (let x = 0; x < width; x++) {
      let red = 0, green = 0, blue = 0;
      for (const [at, weight] of columns[x]!) {
        const i = row + (left + at) * channels;
        red += pixels[i]! * weight;
        green += pixels[i + 1]! * weight;
        blue += pixels[i + 2]! * weight;
      }
      const o = (y * width + x) * 3;
      horizontal[o] = red;
      horizontal[o + 1] = green;
      horizontal[o + 2] = blue;
    }
  }
  const bgra = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let red = 0, green = 0, blue = 0;
      for (const [at, weight] of rows[y]!) {
        const i = (at * width + x) * 3;
        red += horizontal[i]! * weight;
        green += horizontal[i + 1]! * weight;
        blue += horizontal[i + 2]! * weight;
      }
      const o = (y * width + x) * 4;
      bgra[o] = Math.round(blue);
      bgra[o + 1] = Math.round(green);
      bgra[o + 2] = Math.round(red);
      bgra[o + 3] = 255;
    }
  }
  return { width, height, bgra };
}
