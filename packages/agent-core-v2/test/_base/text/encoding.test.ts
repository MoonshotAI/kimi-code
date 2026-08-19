import { describe, expect, it } from 'vitest';

import {
  classifyTextSample,
  decodeUtfText,
  detectTextEncoding,
  ENCODING_DETECTION_SAMPLE_BYTES,
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

describe('splitLinesKeepingTerminator', () => {
  it('keeps line terminators and the unterminated tail', () => {
    expect(splitLinesKeepingTerminator('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLinesKeepingTerminator('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLinesKeepingTerminator('')).toEqual([]);
    expect(splitLinesKeepingTerminator('\n')).toEqual(['\n']);
  });
});
