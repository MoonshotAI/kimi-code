import { describe, expect, it } from 'vitest';

import { fileMetaSchema, type FileMeta } from '../file';

describe('fileMetaSchema (W12.2 / Chain 15)', () => {
  const base: FileMeta = {
    id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    name: 'screenshot.png',
    media_type: 'image/png',
    size: 4096,
    created_at: '2026-06-04T10:00:00.000Z',
  };

  it('round-trips a minimal record without expires_at', () => {
    expect(fileMetaSchema.parse(base)).toEqual(base);
    expect(fileMetaSchema.parse(base).expires_at).toBeUndefined();
  });

  it('round-trips a record with expires_at', () => {
    const withExpiry: FileMeta = {
      ...base,
      expires_at: '2026-06-05T10:00:00.000Z',
    };
    const parsed = fileMetaSchema.parse(withExpiry);
    expect(parsed.expires_at).toBe('2026-06-05T10:00:00.000Z');
  });

  it('accepts size=0 (empty file is legal)', () => {
    expect(fileMetaSchema.parse({ ...base, size: 0 }).size).toBe(0);
  });

  it('rejects a negative size', () => {
    expect(
      fileMetaSchema.safeParse({ ...base, size: -1 }).success,
    ).toBe(false);
  });

  it('rejects empty id / name / media_type', () => {
    expect(fileMetaSchema.safeParse({ ...base, id: '' }).success).toBe(false);
    expect(fileMetaSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(
      fileMetaSchema.safeParse({ ...base, media_type: '' }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO created_at', () => {
    expect(
      fileMetaSchema.safeParse({ ...base, created_at: 'not a date' }).success,
    ).toBe(false);
  });
});
