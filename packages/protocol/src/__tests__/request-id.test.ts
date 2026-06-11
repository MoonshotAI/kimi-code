import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { isUlid, parseOrGenerateRequestId, ulidRegex } from '../request-id';

describe('request-id — ulidRegex', () => {
  it('matches valid 26-char Crockford ULIDs', () => {
    const id = ulid();
    expect(ulidRegex.test(id)).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(ulidRegex.test('not-a-ulid')).toBe(false);
    expect(ulidRegex.test('')).toBe(false);
    expect(ulidRegex.test('01HX')).toBe(false);
    expect(ulidRegex.test('01ARZ3NDEKTSV4RRFFQ69G5FALI')).toBe(false);
  });
});

describe('request-id — parseOrGenerateRequestId', () => {
  it('mints a new ULID when input is undefined', () => {
    const out = parseOrGenerateRequestId(undefined);
    expect(ulidRegex.test(out)).toBe(true);
    expect(isUlid(out)).toBe(true);
  });

  it('mints a new ULID when input is malformed (does not echo back)', () => {
    const malformed = 'not-a-ulid';
    const out = parseOrGenerateRequestId(malformed);
    expect(out).not.toBe(malformed);
    expect(ulidRegex.test(out)).toBe(true);
  });

  it('mints a new ULID when input is empty string', () => {
    const out = parseOrGenerateRequestId('');
    expect(out).not.toBe('');
    expect(ulidRegex.test(out)).toBe(true);
  });

  it('returns a valid ULID input verbatim', () => {
    const supplied = ulid();
    const out = parseOrGenerateRequestId(supplied);
    expect(out).toBe(supplied);
  });

  it('two undefined calls return different ULIDs', () => {
    const a = parseOrGenerateRequestId(undefined);
    const b = parseOrGenerateRequestId(undefined);
    expect(a).not.toBe(b);
  });
});

describe('request-id — isUlid', () => {
  it('accepts a freshly generated ULID', () => {
    expect(isUlid(ulid())).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isUlid('garbage')).toBe(false);
  });
});
