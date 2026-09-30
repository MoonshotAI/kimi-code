import type { BranchHeader, EntryLine, Payload, Result } from '../types';
import { err, ok } from '../types';

export interface CodecError {
  kind: 'syntax' | 'schema' | 'seq';
  detail: string;
}

class CodecException extends Error {
  readonly kind: CodecError['kind'];

  constructor(kind: CodecError['kind'], detail: string) {
    super(detail);
    this.name = 'CodecException';
    this.kind = kind;
  }
}

function parseObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CodecException('syntax', error instanceof Error ? error.message : 'is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodecException('schema', 'is not a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodecException('schema', `has invalid ${key}`);
  }
  return value;
}

function requireTimestamp(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CodecException('schema', `has invalid ${key}`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodecException('schema', `has invalid ${key}`);
  }
  return value;
}

function optionalSeq(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CodecException('schema', `has invalid ${key}`);
  }
  return value;
}

function decodeHeader(raw: string): BranchHeader {
  const obj = parseObject(raw);
  if (obj['kind'] !== 'header') throw new CodecException('schema', 'is not a header');
  if (obj['version'] !== 1) throw new CodecException('schema', 'has unsupported version');
  return {
    version: 1,
    tree: requireString(obj, 'tree'),
    branch: requireString(obj, 'branch'),
    createdAt: requireTimestamp(obj, 'createdAt'),
    parentBranch: optionalString(obj, 'parentBranch'),
    parentSeq: optionalSeq(obj, 'parentSeq'),
  };
}

function decodePayload(value: unknown): Payload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodecException('schema', 'has invalid payload');
  }
  const obj = value as Record<string, unknown>;
  const kind = obj['kind'];
  if (typeof kind !== 'string') throw new CodecException('schema', 'has invalid payload.kind');
  const size = obj['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new CodecException('schema', 'has invalid payload.size');
  }
  const ref = obj['ref'];
  if (ref !== undefined) {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new CodecException('schema', 'has invalid payload.ref');
    }
    return { kind, size, ref };
  }
  if (!('data' in obj)) throw new CodecException('schema', 'has invalid payload.data');
  return { kind, size, data: obj['data'] };
}

function decodeEntry(raw: string, expectedSeq: number): EntryLine {
  const obj = parseObject(raw);
  if (obj['kind'] !== 'entry') throw new CodecException('schema', 'is not an entry');
  const seq = obj['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new CodecException('schema', 'has invalid seq');
  }
  if (seq !== expectedSeq) {
    throw new CodecException('seq', `has seq ${seq}, expected ${expectedSeq}`);
  }
  return {
    kind: 'entry',
    seq,
    ts: requireTimestamp(obj, 'ts'),
    type: requireString(obj, 'type'),
    payload: decodePayload(obj['payload']),
  };
}

function wrap<T>(decode: () => T): Result<T, CodecError> {
  try {
    return ok(decode());
  } catch (error) {
    if (error instanceof CodecException) return err({ kind: error.kind, detail: error.message });
    throw error;
  }
}

export function encodeHeader(header: BranchHeader): string {
  return `${JSON.stringify({ kind: 'header', ...header })}\n`;
}

export function parseHeader(raw: string): Result<BranchHeader, CodecError> {
  return wrap(() => decodeHeader(raw));
}

export function encodeLine(entry: EntryLine): string {
  return `${JSON.stringify(entry)}\n`;
}

export function parseLine(raw: string, expectedSeq: number): Result<EntryLine, CodecError> {
  return wrap(() => decodeEntry(raw, expectedSeq));
}
