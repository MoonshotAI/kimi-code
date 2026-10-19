import { describe, expect, it } from 'vitest';

import { encodeHeader, encodeLine, parseHeader, parseLine } from '#/store/internal/codec';
import type { BranchHeader, EntryLine } from '#/store/types';

describe('codec header', () => {
  it('round-trips a minimal header', () => {
    const header: BranchHeader = { version: 1, tree: 'chat', branch: 'main', createdAt: 1788300000000 };
    expect(parseHeader(encodeHeader(header))).toEqual({ ok: true, value: header });
  });

  it('round-trips a fork header', () => {
    const header: BranchHeader = {
      version: 1,
      tree: 'chat',
      branch: 'fork',
      createdAt: 1,
      parentBranch: 'main',
      parentSeq: 7,
    };
    expect(parseHeader(encodeHeader(header))).toEqual({ ok: true, value: header });
  });

  it('rejects invalid json', () => {
    const result = parseHeader('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('syntax');
  });

  it('rejects a non-header line', () => {
    const result = parseHeader('{"kind":"entry"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('schema');
  });

  it('rejects an unsupported version', () => {
    const result = parseHeader('{"kind":"header","version":2,"tree":"a","branch":"b","createdAt":1}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('schema');
  });

  it('rejects a header without branch', () => {
    const result = parseHeader('{"kind":"header","version":1,"tree":"a","createdAt":1}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('schema');
  });
});

describe('codec line', () => {
  const entry: EntryLine = {
    kind: 'entry',
    seq: 2,
    ts: 100,
    type: 'chat.message',
    payload: { kind: 'text', size: 5, data: 'hello' },
  };

  it('round-trips an entry', () => {
    const encoded = encodeLine(entry);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(parseLine(encoded, 2)).toEqual({ ok: true, value: entry });
  });

  it('round-trips an offloaded payload', () => {
    const offloaded: EntryLine = { ...entry, payload: { kind: 'json', size: 99999, ref: 'abc123' } };
    expect(parseLine(encodeLine(offloaded), 2)).toEqual({ ok: true, value: offloaded });
  });

  it('detects a seq mismatch', () => {
    const result = parseLine(encodeLine(entry), 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('seq');
  });

  it('rejects invalid json', () => {
    const result = parseLine('{"kind":"entry","seq":', 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('syntax');
  });

  it('rejects an unknown kind', () => {
    const result = parseLine('{"kind":"mystery","seq":2,"ts":1}', 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('schema');
  });

  it('rejects a payload without data or ref', () => {
    const result = parseLine(
      '{"kind":"entry","seq":2,"ts":1,"type":"a.b","payload":{"kind":"t","size":1}}',
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('schema');
  });
});
