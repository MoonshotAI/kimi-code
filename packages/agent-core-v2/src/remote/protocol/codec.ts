import { TextDecoder } from 'node:util';

import { ProtocolViolationError } from './messages';

export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = (): TextDecoder => new TextDecoder('utf-8', { fatal: true });

export function encodeFrame(value: unknown): Uint8Array {
  const encoded = utf8Encoder.encode(`${JSON.stringify(value)}\n`);
  if (encoded.byteLength > MAX_MESSAGE_BYTES) {
    throw new ProtocolViolationError(`message exceeds the ${MAX_MESSAGE_BYTES}-byte frame cap`);
  }
  return encoded;
}

export function encodeBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

export function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

export class LineFrameDecoder {

  private pending: Buffer[] = [];
  private pendingBytes = 0;

  push(chunk: Uint8Array): unknown[] {
    const frames: unknown[] = [];
    const buffer: Buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== 0x0a) continue;
      const frame = this.decodeLine(this.takeLine(buffer, start, i));
      if (frame !== undefined) frames.push(frame);
      start = i + 1;
    }
    if (start < buffer.length) {
      this.pending.push(buffer.subarray(start));
      this.pendingBytes += buffer.length - start;
      if (this.pendingBytes > MAX_MESSAGE_BYTES) {
        throw new ProtocolViolationError(`message exceeds the ${MAX_MESSAGE_BYTES}-byte frame cap`);
      }
    }
    return frames;
  }

  private takeLine(buffer: Buffer, start: number, end: number): Buffer {
    const tail = buffer.subarray(start, end);
    if (this.pendingBytes === 0) return tail;
    const parts = tail.length === 0 ? this.pending : [...this.pending, tail];
    this.pending = [];
    this.pendingBytes = 0;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  private decodeLine(line: Buffer): unknown {
    let end = line.length;
    if (end > 0 && line[end - 1] === 0x0d) end -= 1;
    if (end === 0) return undefined;
    if (end > MAX_MESSAGE_BYTES) {
      throw new ProtocolViolationError(`message exceeds the ${MAX_MESSAGE_BYTES}-byte frame cap`);
    }
    let text: string;
    try {
      text = fatalUtf8Decoder().decode(line.subarray(0, end));
    } catch {
      throw new ProtocolViolationError('message is not valid UTF-8');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProtocolViolationError('message is not valid JSON');
    }
  }
}
