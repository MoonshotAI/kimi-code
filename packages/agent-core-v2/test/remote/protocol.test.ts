import { describe, expect, it } from 'vitest';

import {
  encodeFrame,
  LineFrameDecoder,
  MAX_MESSAGE_BYTES,
  ProtocolViolationError,
  compareVersions,
} from '#/remote/protocol/index';

function pushAll(decoder: LineFrameDecoder, chunks: Uint8Array[]): unknown[] {
  const frames: unknown[] = [];
  for (const chunk of chunks) frames.push(...decoder.push(chunk));
  return frames;
}

describe('NDJSON line framing', () => {
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
});

describe('version comparison', () => {
  it('orders semver-ish version strings', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });
});
