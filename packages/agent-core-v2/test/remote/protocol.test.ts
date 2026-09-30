import { describe, expect, it, vi } from 'vitest';

import {
  classifyMessage,
  decodeBase64,
  encodeBase64,
  encodeFrame,
  LineFrameDecoder,
  MAX_MESSAGE_BYTES,
  ProtocolViolationError,
  compareVersions,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
} from '#/remote/protocol/index';

function pushAll(decoder: LineFrameDecoder, chunks: Uint8Array[]): unknown[] {
  const frames: unknown[] = [];
  for (const chunk of chunks) frames.push(...decoder.push(chunk));
  return frames;
}

describe('NDJSON line framing', () => {
  it('decodes newline-terminated frames', () => {
    const decoder = new LineFrameDecoder();
    const frames = pushAll(decoder, [encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('tolerates CRLF line endings', () => {
    const decoder = new LineFrameDecoder();
    const frames = decoder.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n', 'utf8'));
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips blank lines', () => {
    const decoder = new LineFrameDecoder();
    const frames = decoder.push(Buffer.from('\n{"a":1}\n\n\r\n{"b":2}\n', 'utf8'));
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('assembles frames split across packets', () => {
    const decoder = new LineFrameDecoder();
    const encoded = encodeFrame({ hello: 'world' });
    const frames = pushAll(decoder, [encoded.subarray(0, 5), encoded.subarray(5, encoded.length - 2), encoded.subarray(encoded.length - 2)]);
    expect(frames).toEqual([{ hello: 'world' }]);
  });

  it('assembles multi-byte UTF-8 split across packets', () => {
    const decoder = new LineFrameDecoder();
    const encoded = encodeFrame({ text: '你好🙂' });
    const frames: unknown[] = [];
    for (let i = 0; i < encoded.length; i += 3) {
      frames.push(...decoder.push(encoded.subarray(i, i + 3)));
    }
    expect(frames).toEqual([{ text: '你好🙂' }]);
  });

  it('rejects a message over the 64MiB cap', () => {
    const decoder = new LineFrameDecoder();
    const big = Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61);
    expect(() => decoder.push(big)).toThrow(ProtocolViolationError);
  });

  it('rejects an incomplete line that grows past the cap without a newline', () => {
    const decoder = new LineFrameDecoder();
    decoder.push(Buffer.alloc(MAX_MESSAGE_BYTES, 0x61));
    expect(() => decoder.push(Buffer.from('x'))).toThrow(ProtocolViolationError);
  });

  it('assembles a large frame from small chunks with bounded copying', () => {
    const decoder = new LineFrameDecoder();
    const payload = 'x'.repeat(16 * 1024 * 1024);
    const frame = encodeFrame({ data: payload });
    const originalConcat = Buffer.concat.bind(Buffer);
    let copied = 0;
    const concatSpy = vi.spyOn(Buffer, 'concat').mockImplementation((list: readonly Uint8Array[], totalLength?: number) => {
      copied += list.reduce((total, part) => total + part.length, 0);
      return originalConcat(list, totalLength);
    });
    try {
      const frames: unknown[] = [];
      for (let offset = 0; offset < frame.length; offset += 64 * 1024) {
        frames.push(...decoder.push(frame.subarray(offset, offset + 64 * 1024)));
      }
      expect(frames).toEqual([{ data: payload }]);
      expect(copied).toBeLessThanOrEqual(frame.length * 2);
    } finally {
      concatSpy.mockRestore();
    }
  });

  it('rejects invalid UTF-8', () => {
    const decoder = new LineFrameDecoder();
    expect(() => decoder.push(Buffer.from([0xff, 0xfe, 0x0a]))).toThrow(ProtocolViolationError);
  });

  it('rejects invalid JSON', () => {
    const decoder = new LineFrameDecoder();
    expect(() => decoder.push(Buffer.from('{oops}\n', 'utf8'))).toThrow(ProtocolViolationError);
  });

  it('refuses to encode a frame over the cap', () => {
    expect(() => encodeFrame({ data: 'x'.repeat(MAX_MESSAGE_BYTES) })).toThrow(ProtocolViolationError);
  });
});

describe('base64', () => {
  it('round-trips binary data', () => {
    const data = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(decodeBase64(encodeBase64(data))).toEqual(data);
  });
});

describe('message classification', () => {
  it('classifies the four shapes by key presence without a jsonrpc field', () => {
    const request = classifyMessage({ id: 1, method: 'fs/readFile', params: { path: '/x' } });
    expect(isRequest(request)).toBe(true);
    expect(request).toMatchObject({ id: 1, method: 'fs/readFile' });

    const notification = classifyMessage({ method: 'process/output', params: {} });
    expect(isNotification(notification)).toBe(true);

    const response = classifyMessage({ id: 'abc', result: { ok: true } });
    expect(isResponse(response)).toBe(true);

    const error = classifyMessage({ id: 7, error: { code: -32600, message: 'bad' } });
    expect(isErrorResponse(error)).toBe(true);
  });

  it('accepts string and numeric ids', () => {
    expect(classifyMessage({ id: 's', result: 1 })).toMatchObject({ id: 's' });
    expect(classifyMessage({ id: 42, result: 1 })).toMatchObject({ id: 42 });
    expect(() => classifyMessage({ id: null, result: 1 })).toThrow(ProtocolViolationError);
    expect(() => classifyMessage({ id: { x: 1 }, result: 1 })).toThrow(ProtocolViolationError);
  });

  it('carries the error shape {code, message, data?}', () => {
    const withData = classifyMessage({ id: 1, error: { code: -32004, message: 'gone', data: { domainCode: 'os.fs.not_found' } } });
    expect(withData).toEqual({ id: 1, error: { code: -32004, message: 'gone', data: { domainCode: 'os.fs.not_found' } } });
    const withoutData = classifyMessage({ id: 1, error: { code: -32603, message: 'boom' } });
    expect(withoutData).toMatchObject({ error: { code: -32603, message: 'boom' } });
  });

  it('rejects non-objects and malformed shapes', () => {
    expect(() => classifyMessage('hello')).toThrow(ProtocolViolationError);
    expect(() => classifyMessage([1, 2])).toThrow(ProtocolViolationError);
    expect(() => classifyMessage({ method: 5 })).toThrow(ProtocolViolationError);
    expect(() => classifyMessage({ result: 1 })).toThrow(ProtocolViolationError);
    expect(() => classifyMessage({ id: 1 })).toThrow(ProtocolViolationError);
    expect(() => classifyMessage({ id: 1, error: { code: 'x', message: 'm' } })).toThrow(ProtocolViolationError);
  });
});

describe('version comparison', () => {
  it('orders semver-ish version strings', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });
});
