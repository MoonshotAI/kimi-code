export type UtfTextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export interface TextClassification {
  readonly isBinary: boolean;
  readonly encoding: UtfTextEncoding;
}

export const FS_BINARY_NONPRINTABLE_FRACTION = 0.3;

export interface TextEncodingDetection {
  /**
   * Detected encoding. `'utf-8'` when no signal points elsewhere (also the
   * placeholder when `seemsBinary` is true).
   */
  readonly encoding: UtfTextEncoding;
  /**
   * True when zero bytes appear but fit neither UTF-16 pattern — the sample
   * should be treated as binary, not text.
   */
  readonly seemsBinary: boolean;
}

/** Number of leading bytes inspected for the zero-byte heuristic. */
export const ENCODING_DETECTION_SAMPLE_BYTES = 512;

const MIN_ZERO_BYTES_FOR_UTF16 = 2;

const UTF16BE_BOM = [0xfe, 0xff] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function sniffTextEncoding(sample: Uint8Array): TextEncodingDetection {
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

export function classifyTextSample(sample: Uint8Array): TextClassification {
  const sniffed = sniffTextEncoding(sample);
  if (sniffed.seemsBinary || sniffed.encoding !== 'utf-8') {
    return { isBinary: sniffed.seemsBinary, encoding: sniffed.encoding };
  }
  if (sample.includes(0)) {
    return { isBinary: true, encoding: 'utf-8' };
  }
  let end = sample.length;
  for (let i = Math.max(0, sample.length - 3); i < sample.length; i++) {
    const b = sample[i]!;
    const expected =
      b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (expected === 0 || i + expected <= sample.length) continue;
    let validPrefix = true;
    for (let j = i + 1; j < sample.length; j++) {
      const cb = sample[j]!;
      if (cb < 0x80 || cb > 0xbf) {
        validPrefix = false;
        break;
      }
    }
    if (validPrefix) {
      end = i;
      break;
    }
  }
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

/**
 * Detect the encoding of a text file from its leading bytes.
 *
 * Known limitation inherited from the reference implementation: a BOM-less
 * UTF-16 file whose content carries no zero bytes at all (e.g. purely CJK
 * text) is reported as `'utf-8'`; strict UTF-8 decoding of it will then fail
 * or produce garbage. Notepad and most editors write a BOM, so this is rare
 * in practice.
 */
export function detectTextEncoding(sample: Uint8Array): TextEncodingDetection {
  const classification = classifyTextSample(sample);
  return { encoding: classification.encoding, seemsBinary: classification.isBinary };
}

/**
 * Decode bytes in a detected UTF encoding to a JS string. Malformed
 * sequences are replaced (non-fatal) and a leading BOM is stripped.
 */
export function decodeUtfText(bytes: Uint8Array, encoding: UtfTextEncoding): string {
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}
