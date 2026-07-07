import { Readable } from 'node:stream';

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

/**
 * Decode a Buffer into a string with Python-compatible `errors` handling.
 *
 * - `'strict'` (default): throw on invalid sequences (via TextDecoder `fatal: true`)
 * - `'replace'`: substitute each invalid sequence with U+FFFD (TextDecoder default)
 * - `'ignore'`: drop invalid input sequences while preserving valid U+FFFD characters
 *
 * Falls back to `Buffer.toString(encoding)` for encodings TextDecoder does not
 * support (e.g. `hex`, `base64`, `binary`, `latin1`) — those are lossless
 * byte-to-character mappings so `errors` has no effect.
 * @internal
 */
export function decodeTextWithErrors(
  data: Buffer,
  encoding: BufferEncoding,
  errors: 'strict' | 'replace' | 'ignore' = 'strict',
  ignoreBOM: boolean = false,
): string {
  // Map Node's BufferEncoding names to Web TextDecoder labels where the two
  // diverge. Only UTF-family encodings participate in the strict/replace/
  // ignore dance; the others are lossless and use Buffer.toString directly.
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
    // Non-UTF encodings (hex/base64/latin1/binary/ascii) are lossless byte↔
    // character mappings; `errors` is meaningless for them. Return raw.
    return data.toString(encoding);
  }

  if (errors === 'strict') {
    return new TextDecoder(webLabel, { fatal: true, ignoreBOM }).decode(data);
  }

  // 'ignore' must skip invalid input bytes/code units, not delete every
  // replacement character in the decoded output. A file can contain a valid
  // U+FFFD, and Python preserves it under errors="ignore".
  if (errors === 'ignore') {
    return webLabel === 'utf-8' ? decodeUtf8Ignore(data) : decodeUtf16LeIgnore(data);
  }

  // 'replace' → substitute each invalid sequence with U+FFFD (default).
  return new TextDecoder(webLabel, { fatal: false, ignoreBOM }).decode(data);
}

/**
 * Convert a glob pattern segment (e.g. "*.txt", "file?.log") into a RegExp.
 * Mirrors Python pathlib behavior: includes dotfiles, case-sensitive by default.
 * @internal
 */
export function globPatternToRegex(pattern: string, caseSensitive: boolean): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === undefined) break;
    switch (ch) {
      case '*':
        regex += '[^/]*';
        break;
      case '?':
        regex += '[^/]';
        break;
      case '[': {
        const end = pattern.indexOf(']', i + 1);
        if (end === -1) {
          regex += '\\[';
        } else {
          // Glob character classes only use `!` for negation. A literal
          // leading `^` must remain literal even though JS regex char
          // classes treat it as negation in the first position.
          let charClass = pattern.slice(i + 1, end);
          // Escape backslashes inside the class so a trailing backslash
          // does not accidentally escape the closing `]`.
          charClass = charClass.replace(/\\/g, '\\\\');
          if (charClass.startsWith('!')) {
            charClass = '^' + charClass.slice(1);
          } else if (charClass.startsWith('^')) {
            charClass = '\\' + charClass;
          }
          regex += '[' + charClass + ']';
          i = end;
        }
        break;
      }
      case '\\': {
        if (i + 1 < pattern.length) {
          const next = pattern.charAt(i + 1);
          regex += next.replaceAll(/[{}()+.\\[\]^$|]/g, '\\$&');
          // Advance past the escaped character so it is not processed
          // again as a regex metacharacter. match literally.
          i++;
        } else {
          regex += '\\\\';
        }
        break;
      }
      default:
        regex += ch.replaceAll(/[{}()+.\\[\]^$|]/g, '\\$&');
    }
  }
  regex += '$';
  return new RegExp(regex, caseSensitive ? '' : 'i');
}

/**
 * A Readable wrapper that preserves source backpressure while still allowing
 * consumers to read buffered output after the source has ended.
 * @internal
 */
export class BufferedReadable extends Readable {
  private readonly _source: Readable;
  private _ended: boolean = false;

  constructor(source: Readable) {
    // Keep a modest prefetch window so wait()-then-read still works for
    // common small/medium outputs without draining unboundedly.
    super({ highWaterMark: 128 * 1024 });
    this._source = source;
    this._source.on('data', this._onData);
    this._source.on('end', this._onEnd);
    this._source.on('close', this._onClose);
    this._source.on('error', this._onError);
  }

  override _read(): void {
    if (!this._ended && !this.destroyed) {
      this._source.resume();
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this._source.off('data', this._onData);
    this._source.off('end', this._onEnd);
    this._source.off('close', this._onClose);
    this._source.off('error', this._onError);
    this._source.destroy();
    callback(error);
  }

  private readonly _onData = (chunk: string | Uint8Array): void => {
    if (!this.push(chunk)) {
      this._source.pause();
    }
  };

  private readonly _onEnd = (): void => {
    this._ended = true;
    this.push(null);
  };

  private readonly _onClose = (): void => {
    if (!this._ended) {
      this._ended = true;
      this.push(null);
    }
  };

  private readonly _onError = (error: Error): void => {
    this.destroy(error);
  };
}
