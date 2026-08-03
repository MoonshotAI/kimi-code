/**
 * `_base/execEnv` (L0) — Python-compatible text decoding with `errors` handling.
 *
 * Vendored from `@moonshot-ai/kaos` `internal.ts`. Kept as a pure helper with
 * no DI dependencies. Used by session-scoped fs implementations to read text
 * files with the same `strict`/`replace`/`ignore` semantics Python's
 * `open(..., errors=)` provides.
 */

export type TextDecodeErrors = 'strict' | 'replace' | 'ignore';

function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function decodeUtf8Ignore(data: Buffer): string {
  let output = '';
  let i = 0;

  while (i < data.length) {
    const b0 = data[i];
    if (b0 === undefined) break;

    if (b0 <= 0x7f) {
      output += String.fromCodePoint(b0);
      i += 1;
      continue;
    }

    if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = data[i + 1];
      if (b1 !== undefined && isUtf8Continuation(b1)) {
        output += String.fromCodePoint(((b0 & 0x1f) << 6) | (b1 & 0x3f));
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      const validSecond =
        b1 !== undefined &&
        ((b0 === 0xe0 && b1 >= 0xa0 && b1 <= 0xbf) ||
          (b0 >= 0xe1 && b0 <= 0xec && isUtf8Continuation(b1)) ||
          (b0 === 0xed && b1 >= 0x80 && b1 <= 0x9f) ||
          (b0 >= 0xee && b0 <= 0xef && isUtf8Continuation(b1)));

      if (validSecond && b2 !== undefined && isUtf8Continuation(b2)) {
        output += String.fromCodePoint(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }

    if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      const b3 = data[i + 3];
      const validSecond =
        b1 !== undefined &&
        ((b0 === 0xf0 && b1 >= 0x90 && b1 <= 0xbf) ||
          (b0 >= 0xf1 && b0 <= 0xf3 && isUtf8Continuation(b1)) ||
          (b0 === 0xf4 && b1 >= 0x80 && b1 <= 0x8f));

      if (
        validSecond &&
        b2 !== undefined &&
        b3 !== undefined &&
        isUtf8Continuation(b2) &&
        isUtf8Continuation(b3)
      ) {
        output += String.fromCodePoint(
          ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f),
        );
        i += 4;
        continue;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return output;
}

function decodeUtf16LeIgnore(data: Buffer): string {
  let output = '';
  let i = 0;

  while (i + 1 < data.length) {
    const first = data[i];
    const second = data[i + 1];
    if (first === undefined || second === undefined) break;

    const codeUnit = first | (second << 8);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const lowFirst = data[i + 2];
      const lowSecond = data[i + 3];
      if (lowFirst !== undefined && lowSecond !== undefined) {
        const low = lowFirst | (lowSecond << 8);
        if (low >= 0xdc00 && low <= 0xdfff) {
          const codePoint = 0x10000 + ((codeUnit - 0xd800) << 10) + (low - 0xdc00);
          output += String.fromCodePoint(codePoint);
          i += 4;
          continue;
        }
      }
      i += 2;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      i += 2;
      continue;
    }

    output += String.fromCodePoint(codeUnit);
    i += 2;
  }

  return output;
}

export function decodeTextWithErrors(
  data: Buffer,
  encoding: BufferEncoding,
  errors: TextDecodeErrors = 'strict',
  ignoreBOM: boolean = false,
): string {
  let webLabel: string | undefined;
  // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
  switch (encoding) {
    case 'utf-8':
    case 'utf8':
      webLabel = 'utf-8';
      break;
    case 'utf16le':
    case 'ucs2':
    case 'ucs-2':
      webLabel = 'utf-16le';
      break;
    default:
      webLabel = undefined;
  }

  if (webLabel === undefined) {
    return data.toString(encoding);
  }

  if (errors === 'strict') {
    return new TextDecoder(webLabel, { fatal: true, ignoreBOM }).decode(data);
  }

  if (errors === 'ignore') {
    return webLabel === 'utf-8' ? decodeUtf8Ignore(data) : decodeUtf16LeIgnore(data);
  }

  return new TextDecoder(webLabel, { fatal: false, ignoreBOM }).decode(data);
}
