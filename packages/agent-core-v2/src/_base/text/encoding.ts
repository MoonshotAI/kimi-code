/**
 * `_base` text helpers — UTF text encoding detection and decoding.
 *
 * Detection algorithm derived from VS Code
 * `src/vs/workbench/services/textfile/common/encoding.ts`
 * (MIT License, Copyright (c) Microsoft Corporation): BOM sniffing plus a
 * zero-byte parity heuristic that recognizes BOM-less UTF-16 LE/BE, so text
 * files saved as UTF-16 (e.g. Windows Notepad `.txt`) can be transcoded to
 * UTF-8 instead of being refused as binary.
 *
 * The parity heuristic deliberately deviates from VS Code in one way: VS
 * Code requires *every* byte pair to conform (a single CJK character, whose
 * UTF-16 unit carries no zero byte, falsifies the pattern and the file is
 * deemed binary). Here, zero bytes must instead appear at least twice and at
 * exactly one parity — odd indices mean UTF-16 LE (`0xAA 0x00`), even
 * indices mean UTF-16 BE (`0x00 0xAA`) — which tolerates mixed Latin/CJK
 * content while still rejecting real binaries (zeros at both parities, or
 * an isolated zero byte). Legacy 8-bit encodings (GBK, Big5, Shift-JIS, …)
 * are never guessed — a wrong silent guess is worse than a clear refusal.
 *
 * Pure functions over bytes; no io happens here.
 */

export type UtfTextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

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

/**
 * Minimum zero bytes (at a single parity) before the BOM-less UTF-16
 * heuristic commits. One isolated zero byte is too ambiguous — a short
 * binary blob like `"plain prefix" + 00 01` would otherwise masquerade as
 * UTF-16 BE.
 */
const MIN_ZERO_BYTES_FOR_UTF16 = 2;

const UTF16BE_BOM = [0xfe, 0xff] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

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
  // Always trust a BOM first.
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

  // BOM-less UTF-16: zero bytes cluster at one parity — odd indices for LE
  // (`0xAA 0x00`), even for BE (`0x00 0xAA`). CJK units carry no zero byte,
  // so only the *placement* of zeros is checked, not their density. Zeros
  // at both parities, or fewer than the ambiguity threshold, mean binary.
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

/**
 * Decode bytes in a detected UTF encoding to a JS string. Malformed
 * sequences are replaced (non-fatal) and a leading BOM is stripped.
 */
export function decodeUtfText(bytes: Uint8Array, encoding: UtfTextEncoding): string {
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}
