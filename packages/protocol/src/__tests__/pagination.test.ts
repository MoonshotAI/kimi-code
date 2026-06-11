import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../error-codes';
import { CursorQuery, cursorQuerySchema, pageResponseSchema } from '../pagination';
import { z } from 'zod';

describe('pagination — CursorQuery', () => {
  it('alias and schema are the same object', () => {
    expect(CursorQuery).toBe(cursorQuerySchema);
  });

  it('accepts empty query (first-page fetch)', () => {
    expect(cursorQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts before_id alone', () => {
    const result = cursorQuerySchema.safeParse({ before_id: 'msg_01HX', page_size: 50 });
    expect(result.success).toBe(true);
  });

  it('accepts after_id alone', () => {
    const result = cursorQuerySchema.safeParse({ after_id: 'msg_01HX', page_size: 50 });
    expect(result.success).toBe(true);
  });

  it('rejects before_id + after_id simultaneously with 40001-mapped issue', () => {
    const result = cursorQuerySchema.safeParse({ before_id: 'x', after_id: 'y' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const mutexIssue = result.error.issues.find(
        (issue) =>
          issue.code === 'custom' &&
          (issue.params as { code?: number } | undefined)?.code === ErrorCode.VALIDATION_FAILED,
      );
      expect(mutexIssue).toBeDefined();
      expect(mutexIssue?.message).toMatch(/mutually exclusive/);
    }
  });

  it('rejects page_size below 1', () => {
    expect(cursorQuerySchema.safeParse({ page_size: 0 }).success).toBe(false);
  });

  it('rejects page_size above 100 (SCHEMAS.md §1.3 hard upper bound)', () => {
    expect(cursorQuerySchema.safeParse({ page_size: 101 }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ page_size: 300 }).success).toBe(false);
  });

  it('rejects non-integer page_size', () => {
    expect(cursorQuerySchema.safeParse({ page_size: 50.5 }).success).toBe(false);
  });
});

describe('pagination — pageResponseSchema', () => {
  it('shapes `data` as { items, has_more } only — no next_cursor', () => {
    const schema = pageResponseSchema(z.object({ id: z.string() }));
    const value = schema.parse({
      items: [{ id: 'a' }, { id: 'b' }],
      has_more: true,
    });
    expect(value.items).toHaveLength(2);
    expect(value.has_more).toBe(true);
    expect((value as Record<string, unknown>)['next_cursor']).toBeUndefined();
  });

  it('rejects missing has_more', () => {
    const schema = pageResponseSchema(z.unknown());
    expect(schema.safeParse({ items: [] }).success).toBe(false);
  });

  it('rejects non-array items', () => {
    const schema = pageResponseSchema(z.unknown());
    expect(schema.safeParse({ items: 'oops', has_more: false }).success).toBe(false);
  });
});
