import { describe, expect, it } from 'vitest';

import {
  byteOrderMarkBytes,
  classifyTextSample,
  decodeUtfText,
  detectTextEncoding,
  encodeUtfText,
  ENCODING_DETECTION_SAMPLE_BYTES,
  hasUtf32ByteOrderMark,
  isStrictlyValidUtf16,
  isStrictlyValidUtf8,
  splitByteOrderMark,
} from '#/_base/text/encoding';
import { splitLinesKeepingTerminator } from '#/_base/text/line-endings';

function utf16Le(text: string): Buffer {
  return Buffer.from(text, 'utf16le');
}

function utf16Be(text: string): Buffer {
  const le = utf16Le(text);
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]!;
    be[i + 1] = le[i]!;
  }
  return be;
}

describe('detectTextEncoding', () => {
  it('detects encodings by BOM', () => {
    expect(detectTextEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).encoding).toBe('utf-8');
    expect(detectTextEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])).encoding).toBe('utf-16le');
    expect(detectTextEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61])).encoding).toBe('utf-16be');
  });

  it('treats UTF-32 BOMs as unsupported binary rather than UTF-16', () => {
    const le = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]);
    expect(detectTextEncoding(le).seemsBinary).toBe(true);
    const be = Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]);
    expect(detectTextEncoding(be).seemsBinary).toBe(true);
  });

  it('trusts the BOM even when the sample carries no zero bytes (CJK-only)', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Le('你好世界')]);
    expect(detectTextEncoding(le)).toEqual({ encoding: 'utf-16le', seemsBinary: false });
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16Be('你好世界')]);
    expect(detectTextEncoding(be)).toEqual({ encoding: 'utf-16be', seemsBinary: false });
  });

  it('detects BOM-less UTF-16 by the zero-byte parity heuristic', () => {
    expect(detectTextEncoding(utf16Le('hello world, plain ascii')).encoding).toBe('utf-16le');
    expect(detectTextEncoding(utf16Be('hello world, plain ascii')).encoding).toBe('utf-16be');
  });

  it('tolerates CJK characters in BOM-less UTF-16 (their units carry no zero byte)', () => {
    expect(detectTextEncoding(utf16Le('hello 你好\nsecond line')).encoding).toBe('utf-16le');
    expect(detectTextEncoding(utf16Be('hello 你好\nsecond line')).encoding).toBe('utf-16be');
  });

  it('reports BOM-less UTF-16 with no zero bytes at all as utf-8 (known limitation)', () => {
    expect(detectTextEncoding(utf16Le('你好世界')).encoding).toBe('utf-8');
  });

  it('treats an isolated zero byte as binary (too ambiguous)', () => {
    expect(detectTextEncoding(Buffer.from([0x61, 0x00])).seemsBinary).toBe(true);
    expect(detectTextEncoding(Buffer.from([0x00, 0x61])).seemsBinary).toBe(true);
  });

  it('limits the zero-byte heuristic to the leading sample window', () => {
    const sample = Buffer.alloc(ENCODING_DETECTION_SAMPLE_BYTES + 2, 0x61);
    sample[ENCODING_DETECTION_SAMPLE_BYTES + 1] = 0x00;
    expect(detectTextEncoding(sample)).toEqual({ encoding: 'utf-8', seemsBinary: true });
  });

  it('flags zero bytes at both parities as binary', () => {
    expect(detectTextEncoding(Buffer.from([0x00, 0x00, 0x61, 0x62])).seemsBinary).toBe(true);
    const prefix = Buffer.concat([Buffer.from('plain prefix'), Buffer.from([0x00, 0x01])]);
    expect(detectTextEncoding(prefix).seemsBinary).toBe(true);
  });

  it('treats plain ASCII / UTF-8 and empty samples as utf-8 text', () => {
    expect(detectTextEncoding(new Uint8Array())).toEqual({ encoding: 'utf-8', seemsBinary: false });
    expect(detectTextEncoding(Buffer.from('plain ascii\n')).seemsBinary).toBe(false);
    expect(detectTextEncoding(Buffer.from('中文内容\n', 'utf8'))).toEqual({
      encoding: 'utf-8',
      seemsBinary: false,
    });
  });
});

describe('classifyTextSample', () => {
  it('classifies UTF-8 multibyte text (CJK, emoji) as utf-8 text', () => {
    const sample = Buffer.from('2026-08-16 INFO 启动完成 ✅\n处理请求 🚀 成功\n'.repeat(20), 'utf8');
    expect(classifyTextSample(sample)).toEqual({ isBinary: false, encoding: 'utf-8' });
  });

  it('classifies an empty sample as utf-8 text', () => {
    expect(classifyTextSample(new Uint8Array())).toEqual({ isBinary: false, encoding: 'utf-8' });
  });

  it('classifies samples carrying NUL bytes as binary', () => {
    expect(
      classifyTextSample(Buffer.from([0x61, 0x62, 0x63, 0x00, 0x64, 0x65, 0x66])).isBinary,
    ).toBe(true);
    expect(classifyTextSample(Buffer.from([0x00, 0x00, 0x61, 0x62])).isBinary).toBe(true);
  });

  it('classifies control-char-heavy samples over the threshold as binary', () => {
    const sample = Buffer.concat([Buffer.alloc(40, 0x1b), Buffer.alloc(60, 0x61)]);
    expect(classifyTextSample(sample).isBinary).toBe(true);
  });

  it('keeps ANSI-colored log lines under the control-char threshold as text', () => {
    const esc = String.fromCodePoint(0x1b);
    const sample = Buffer.from(`${esc}[32mINFO${esc}[0m 启动完成 ✅\n`.repeat(10), 'utf8');
    expect(classifyTextSample(sample)).toEqual({ isBinary: false, encoding: 'utf-8' });
  });

  it('classifies invalid UTF-8 without UTF-16 features as binary', () => {
    expect(classifyTextSample(Buffer.from([0xd6, 0xd0, 0xc4, 0xe3, 0x31, 0x32]))).toEqual({
      isBinary: true,
      encoding: 'utf-8',
    });
  });

  it('tolerates a multi-byte sequence truncated at the sample tail', () => {
    const sample = Buffer.concat([Buffer.from('日志记录\n', 'utf8'), Buffer.from([0xe4, 0xb8])]);
    expect(classifyTextSample(sample)).toEqual({ isBinary: false, encoding: 'utf-8' });
  });

  it('treats a NUL byte beyond the UTF-16 parity window as binary', () => {
    const sample = Buffer.concat([
      Buffer.alloc(600, 0x61),
      Buffer.from([0x00]),
      Buffer.alloc(100, 0x62),
    ]);
    expect(classifyTextSample(sample).isBinary).toBe(true);
  });

  it('rejects an impossible UTF-8 lead byte at the sample tail', () => {
    const sample = Buffer.concat([Buffer.from('plain ascii log line\n'), Buffer.from([0xff])]);
    expect(classifyTextSample(sample).isBinary).toBe(true);
  });

  it('rejects a tail lead byte not followed by continuation bytes', () => {
    const sample = Buffer.concat([Buffer.from('plain ascii log line\n'), Buffer.from([0xe4, 0x41])]);
    expect(classifyTextSample(sample).isBinary).toBe(true);
  });

  it('classifies UTF-16 BOM and zero-byte parity samples as text with the right encoding', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Le('hello 你好')]);
    expect(classifyTextSample(le)).toEqual({ isBinary: false, encoding: 'utf-16le' });
    expect(classifyTextSample(utf16Be('hello world, plain ascii'))).toEqual({
      isBinary: false,
      encoding: 'utf-16be',
    });
  });
});

describe('decodeUtfText', () => {
  it('decodes UTF-16 LE/BE and strips the BOM', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Le('你好\nworld')]);
    expect(decodeUtfText(le, 'utf-16le')).toBe('你好\nworld');
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16Be('你好\nworld')]);
    expect(decodeUtfText(be, 'utf-16be')).toBe('你好\nworld');
  });

  it('decodes UTF-8 and strips the BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text', 'utf8')]);
    expect(decodeUtfText(bytes, 'utf-8')).toBe('text');
  });

  it('replaces malformed sequences instead of throwing', () => {
    expect(decodeUtfText(Buffer.from([0xff]), 'utf-16le')).toBe('�');
  });
});

describe('encodeUtfText', () => {
  it('encodes UTF-8 without adding a BOM', () => {
    expect(Array.from(encodeUtfText('abc', 'utf-8'))).toEqual(Array.from(Buffer.from('abc', 'utf8')));
  });

  it('encodes UTF-16LE/BE with the expected byte order', () => {
    expect(Array.from(encodeUtfText('你好', 'utf-16le'))).toEqual(Array.from(utf16Le('你好')));
    expect(Array.from(encodeUtfText('你好', 'utf-16be'))).toEqual(Array.from(utf16Be('你好')));
  });

  it('round-trips through byteOrderMarkBytes + decodeUtfText for all three encodings', () => {
    for (const encoding of ['utf-8', 'utf-16le', 'utf-16be'] as const) {
      const bom = byteOrderMarkBytes(encoding);
      const payload = Buffer.concat([Buffer.from(bom), Buffer.from(encodeUtfText('hi 世界', encoding))]);
      expect(decodeUtfText(payload, encoding)).toBe('hi 世界');
    }
  });

  it('returns the canonical BOM byte sequences', () => {
    expect(Array.from(byteOrderMarkBytes('utf-8'))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(byteOrderMarkBytes('utf-16le'))).toEqual([0xff, 0xfe]);
    expect(Array.from(byteOrderMarkBytes('utf-16be'))).toEqual([0xfe, 0xff]);
  });
});

describe('splitByteOrderMark', () => {
  it('splits a UTF-8 BOM from the body', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text', 'utf8')]);
    const split = splitByteOrderMark(bytes);
    expect(split.bom).toBe('utf-8');
    expect(Buffer.from(split.body).toString('utf8')).toBe('text');
  });

  it('splits UTF-16 LE/BE BOMs from the body', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Le('hi')]);
    expect(splitByteOrderMark(le).bom).toBe('utf-16le');
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16Be('hi')]);
    expect(splitByteOrderMark(be).bom).toBe('utf-16be');
  });

  it('does not split UTF-32 BOMs, leaving callers on the no-BOM path', () => {
    const le = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]);
    const splitLe = splitByteOrderMark(le);
    expect(splitLe.bom).toBeUndefined();
    expect(Buffer.from(splitLe.body).equals(le)).toBe(true);
    const be = Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]);
    expect(splitByteOrderMark(be).bom).toBeUndefined();
  });

  it('returns the original bytes when there is no BOM', () => {
    const bytes = Buffer.from('plain', 'utf8');
    const split = splitByteOrderMark(bytes);
    expect(split.bom).toBeUndefined();
    expect(split.body).toBe(bytes);
  });

  it('does not misread short or BOM-like prefixes', () => {
    expect(splitByteOrderMark(Buffer.from([0xef, 0xbb])).bom).toBeUndefined();
    expect(splitByteOrderMark(Buffer.from([0xef])).bom).toBeUndefined();
    expect(splitByteOrderMark(new Uint8Array()).bom).toBeUndefined();
    expect(splitByteOrderMark(Buffer.from([0xff, 0x00])).bom).toBeUndefined();
  });
});

describe('hasUtf32ByteOrderMark', () => {
  it('detects UTF-32 LE/BE BOMs without confusing them with UTF-16', () => {
    expect(hasUtf32ByteOrderMark(Buffer.from([0xff, 0xfe, 0x00, 0x00]))).toBe(true);
    expect(hasUtf32ByteOrderMark(Buffer.from([0x00, 0x00, 0xfe, 0xff]))).toBe(true);
    expect(hasUtf32ByteOrderMark(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe(false);
    expect(hasUtf32ByteOrderMark(Buffer.from([0xfe, 0xff]))).toBe(false);
    expect(hasUtf32ByteOrderMark(Buffer.from([0xff, 0xfe]))).toBe(false);
  });
});

describe('splitLinesKeepingTerminator', () => {
  it('keeps line terminators and the unterminated tail', () => {
    expect(splitLinesKeepingTerminator('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLinesKeepingTerminator('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLinesKeepingTerminator('')).toEqual([]);
    expect(splitLinesKeepingTerminator('\n')).toEqual(['\n']);
  });
});

describe('isStrictlyValidUtf8', () => {
  it('rejects a complete sample ending in a partial sequence', () => {
    expect(isStrictlyValidUtf8(Uint8Array.from([0x61, 0xc2]), true)).toBe(false);
  });

  it('tolerates the same bytes when the sample is known to be cut', () => {
    expect(isStrictlyValidUtf8(Uint8Array.from([0x61, 0xc2]), false)).toBe(true);
  });

  it('accepts a complete sample whose trailing sequence is complete', () => {
    expect(isStrictlyValidUtf8(Uint8Array.from([0x61, 0xc2, 0xa9]), true)).toBe(true);
  });

  it('keeps rejecting binary and non-UTF-8 samples regardless of completeness', () => {
    expect(isStrictlyValidUtf8(Uint8Array.from([0x00, 0x01]), true)).toBe(false);
    expect(isStrictlyValidUtf8(utf16Le('ab'), true)).toBe(false);
  });
});

describe('isStrictlyValidUtf16', () => {
  it('rejects a complete body with an unpaired high surrogate', () => {
    expect(isStrictlyValidUtf16(Uint8Array.from([0x61, 0x00, 0x00, 0xd8]), 'utf-16le', true)).toBe(
      false,
    );
  });

  it('tolerates the same body when the sample is known to be cut', () => {
    expect(
      isStrictlyValidUtf16(Uint8Array.from([0x61, 0x00, 0x00, 0xd8]), 'utf-16le', false),
    ).toBe(true);
  });

  it('accepts a complete well-formed body and rejects an odd one', () => {
    expect(isStrictlyValidUtf16(Uint8Array.from([0x61, 0x00]), 'utf-16le', true)).toBe(true);
    expect(isStrictlyValidUtf16(Uint8Array.from([0x61, 0x00, 0x62]), 'utf-16le', true)).toBe(false);
  });

  it('rejects impossible lead-specific prefixes even when the sample is cut', () => {
    expect(isStrictlyValidUtf8(Uint8Array.from([0xe0, 0x80]), false)).toBe(false);
    expect(isStrictlyValidUtf8(Uint8Array.from([0xed, 0xa0]), false)).toBe(false);
    expect(isStrictlyValidUtf8(Uint8Array.from([0xf0, 0x80]), false)).toBe(false);
    expect(isStrictlyValidUtf8(Uint8Array.from([0xf4, 0x90]), false)).toBe(false);
  });

  it('still tolerates cut samples whose visible prefix can complete', () => {
    expect(isStrictlyValidUtf8(Uint8Array.from([0xe0, 0xa0]), false)).toBe(true);
    expect(isStrictlyValidUtf8(Uint8Array.from([0xed, 0x9f]), false)).toBe(true);
    expect(isStrictlyValidUtf8(Uint8Array.from([0xf0, 0x90]), false)).toBe(true);
    expect(isStrictlyValidUtf8(Uint8Array.from([0xf4, 0x8f]), false)).toBe(true);
  });
});

describe('encodeUtfText well-formedness', () => {
  it('replaces lone surrogates in UTF-16 output so payloads stay strictly valid', () => {
    const le = encodeUtfText('a\uD800b\uDC00c', 'utf-16le');
    expect(new TextDecoder('utf-16le', { fatal: true }).decode(le)).toBe('a\uFFFDb\uFFFDc');
    const be = encodeUtfText('\uD800', 'utf-16be');
    expect(new TextDecoder('utf-16be', { fatal: true }).decode(be)).toBe('\uFFFD');
  });

  it('keeps valid surrogate pairs intact through re-encoding', () => {
    const le = encodeUtfText('\u{10000}', 'utf-16le');
    expect(new TextDecoder('utf-16le', { fatal: true }).decode(le)).toBe('\u{10000}');
  });
});

describe('BOM-less UTF-16 ambiguity policy', () => {
  it('treats BOM-less UTF-16 bytes that are also valid UTF-8 as UTF-8', () => {
    const bytes = Buffer.from('你好世界', 'utf16le');
    expect([...bytes]).toEqual([0x60, 0x4f, 0x7d, 0x59, 0x16, 0x4e, 0x4c, 0x75]);
    expect(classifyTextSample(bytes)).toEqual({ isBinary: false, encoding: 'utf-8' });
    expect(isStrictlyValidUtf8(bytes, true)).toBe(true);
  });
});
