export type UtfTextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export interface TextClassification {
  readonly isBinary: boolean;
  readonly encoding: UtfTextEncoding;
}

export const FS_BINARY_NONPRINTABLE_FRACTION = 0.3;

export interface TextEncodingDetection {
  readonly encoding: UtfTextEncoding;
  readonly seemsBinary: boolean;
}

export const ENCODING_DETECTION_SAMPLE_BYTES = 512;

const MIN_ZERO_BYTES_FOR_UTF16 = 2;

const UTF16BE_BOM = [0xfe, 0xff] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF32LE_BOM = [0xff, 0xfe, 0x00, 0x00] as const;
const UTF32BE_BOM = [0x00, 0x00, 0xfe, 0xff] as const;

export function hasUtf32ByteOrderMark(sample: Uint8Array): boolean {
  if (sample.length < 4) return false;
  const b0 = sample[0]!;
  const b1 = sample[1]!;
  const b2 = sample[2]!;
  const b3 = sample[3]!;
  return (
    (b0 === UTF32LE_BOM[0] && b1 === UTF32LE_BOM[1] && b2 === UTF32LE_BOM[2] && b3 === UTF32LE_BOM[3]) ||
    (b0 === UTF32BE_BOM[0] && b1 === UTF32BE_BOM[1] && b2 === UTF32BE_BOM[2] && b3 === UTF32BE_BOM[3])
  );
}

function sniffTextEncoding(sample: Uint8Array): TextEncodingDetection {
  if (hasUtf32ByteOrderMark(sample)) {
    return { encoding: 'utf-8', seemsBinary: true };
  }
  if (sample.length >= 2) {
    const b0 = sample[0]!;
    const b1 = sample[1]!;
    if (b0 === UTF16BE_BOM[0] && b1 === UTF16BE_BOM[1]) {
      return { encoding: 'utf-16be', seemsBinary: false };
    }
    if (b0 === UTF16LE_BOM[0] && b1 === UTF16LE_BOM[1]) {
      return { encoding: 'utf-16le', seemsBinary: false };
    }
    if (sample.length >= 3 && b0 === UTF8_BOM[0] && b1 === UTF8_BOM[1] && sample[2] === UTF8_BOM[2]) {
      return { encoding: 'utf-8', seemsBinary: false };
    }
  }

  let zerosAtOdd = 0;
  let zerosAtEven = 0;
  const limit = Math.min(sample.length, ENCODING_DETECTION_SAMPLE_BYTES);
  for (let i = 0; i < limit; i++) {
    if (sample[i] !== 0) continue;
    if (i % 2 === 1) zerosAtOdd++;
    else zerosAtEven++;
  }

  if (zerosAtOdd === 0 && zerosAtEven === 0) {
    return { encoding: 'utf-8', seemsBinary: false };
  }
  if (zerosAtEven === 0 && zerosAtOdd >= MIN_ZERO_BYTES_FOR_UTF16) {
    return { encoding: 'utf-16le', seemsBinary: false };
  }
  if (zerosAtOdd === 0 && zerosAtEven >= MIN_ZERO_BYTES_FOR_UTF16) {
    return { encoding: 'utf-16be', seemsBinary: false };
  }
  return { encoding: 'utf-8', seemsBinary: true };
}

function utf8ContinuationBounds(lead: number, index: number): readonly [number, number] {
  if (index === 0) {
    if (lead === 0xe0) return [0xa0, 0xbf];
    if (lead === 0xed) return [0x80, 0x9f];
    if (lead === 0xf0) return [0x90, 0xbf];
    if (lead === 0xf4) return [0x80, 0x8f];
  }
  return [0x80, 0xbf];
}

function trailingPartialUtf8Length(sample: Uint8Array): number {
  for (let i = Math.max(0, sample.length - 3); i < sample.length; i++) {
    const b = sample[i]!;
    const expected =
      b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (expected === 0 || i + expected <= sample.length) continue;
    let validPrefix = true;
    for (let j = i + 1; j < sample.length; j++) {
      const [lo, hi] = utf8ContinuationBounds(b, j - i - 1);
      const cb = sample[j]!;
      if (cb < lo || cb > hi) {
        validPrefix = false;
        break;
      }
    }
    if (validPrefix) return sample.length - i;
  }
  return 0;
}

export function classifyTextSample(sample: Uint8Array): TextClassification {
  const sniffed = sniffTextEncoding(sample);
  if (sniffed.seemsBinary || sniffed.encoding !== 'utf-8') {
    return { isBinary: sniffed.seemsBinary, encoding: sniffed.encoding };
  }
  if (sample.includes(0)) {
    return { isBinary: true, encoding: 'utf-8' };
  }
  const end = sample.length - trailingPartialUtf8Length(sample);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, end));
  } catch {
    return { isBinary: true, encoding: 'utf-8' };
  }
  let nonPrintable = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    total++;
    if (cp === 9 || cp === 10 || cp === 13) continue;
    if (cp < 32 || (cp >= 0x7f && cp <= 0x9f)) nonPrintable++;
  }
  if (total > 0 && nonPrintable / total > FS_BINARY_NONPRINTABLE_FRACTION) {
    return { isBinary: true, encoding: 'utf-8' };
  }
  return { isBinary: false, encoding: 'utf-8' };
}

export function detectTextEncoding(sample: Uint8Array): TextEncodingDetection {
  const classification = classifyTextSample(sample);
  return { encoding: classification.encoding, seemsBinary: classification.isBinary };
}

export function decodeUtfText(bytes: Uint8Array, encoding: UtfTextEncoding): string {
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

export type ByteOrderMark = 'utf-8' | 'utf-16le' | 'utf-16be';

export interface ByteOrderMarkSplit {
  readonly bom: ByteOrderMark | undefined;
  readonly body: Uint8Array;
}

export function splitByteOrderMark(bytes: Uint8Array): ByteOrderMarkSplit {
  if (hasUtf32ByteOrderMark(bytes)) {
    return { bom: undefined, body: bytes };
  }
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === UTF8_BOM[0] && b1 === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    return { bom: 'utf-8', body: bytes.subarray(3) };
  }
  if (b0 === UTF16BE_BOM[0] && b1 === UTF16BE_BOM[1]) {
    return { bom: 'utf-16be', body: bytes.subarray(2) };
  }
  if (b0 === UTF16LE_BOM[0] && b1 === UTF16LE_BOM[1]) {
    return { bom: 'utf-16le', body: bytes.subarray(2) };
  }
  return { bom: undefined, body: bytes };
}

export function byteOrderMarkBytes(bom: ByteOrderMark): Uint8Array {
  switch (bom) {
    case 'utf-8':
      return Uint8Array.of(UTF8_BOM[0], UTF8_BOM[1], UTF8_BOM[2]);
    case 'utf-16le':
      return Uint8Array.of(UTF16LE_BOM[0], UTF16LE_BOM[1]);
    case 'utf-16be':
      return Uint8Array.of(UTF16BE_BOM[0], UTF16BE_BOM[1]);
  }
}

export function encodeUtfText(text: string, encoding: UtfTextEncoding): Uint8Array {
  if (encoding === 'utf-8') {
    return new TextEncoder().encode(text);
  }
  const le = Buffer.from(toWellFormedText(text), 'utf16le');
  if (encoding === 'utf-16le') {
    return le;
  }
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1]!;
    be[i + 1] = le[i]!;
  }
  return be;
}

export const SAMPLE_LOOKAHEAD_BYTES = 4;

function toWellFormedText(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++;
      continue;
    }
    if (cp >= 0xd800 && cp <= 0xdfff) return rebuildWellFormed(text, i);
  }
  return text;
}

function rebuildWellFormed(text: string, from: number): string {
  let out = text.slice(0, from);
  for (let i = from; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      out += String.fromCodePoint(cp);
      i++;
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += text[i]!;
    }
  }
  return out;
}

export function isStrictlyValidUtf8(region: Uint8Array, complete: boolean): boolean {
  const classification = classifyTextSample(region);
  if (classification.isBinary || classification.encoding !== 'utf-8') {
    return false;
  }
  const end = complete ? region.length : region.length - trailingPartialUtf8Length(region);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(region.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

export function isStrictlyValidUtf16(
  body: Uint8Array,
  bom: Exclude<ByteOrderMark, 'utf-8'>,
  complete: boolean,
): boolean {
  let end = body.length;
  if (!complete) {
    end -= body.length % 2;
    if (end >= 2) {
      const unit =
        bom === 'utf-16le'
          ? (body[end - 1]! << 8) | body[end - 2]!
          : (body[end - 2]! << 8) | body[end - 1]!;
      if (unit >= 0xd800 && unit <= 0xdbff) end -= 2;
    }
  }
  try {
    new TextDecoder(bom, { fatal: true }).decode(body.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}
