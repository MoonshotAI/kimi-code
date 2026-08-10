import { describe, expect, it } from 'vitest';

import {
  getMessageResponseSchema,
  listMessagesQuerySchema,
  listMessagesResponseSchema,
} from '../rest/message';

describe('listMessagesQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(listMessagesQuerySchema.parse({})).toEqual({});
  });

  it('accepts before_id + page_size + role', () => {
    const parsed = listMessagesQuerySchema.parse({
      before_id: 'msg_abc',
      page_size: 25,
      role: 'assistant',
    });
    expect(parsed.before_id).toBe('msg_abc');
    expect(parsed.page_size).toBe(25);
    expect(parsed.role).toBe('assistant');
  });

  it('rejects before_id + after_id together', () => {
    expect(
      listMessagesQuerySchema.safeParse({ before_id: 'a', after_id: 'b' }).success,
    ).toBe(false);
  });

  it('rejects page_size > 100 (SCHEMAS §1.3 / REST §1.6)', () => {
    expect(listMessagesQuerySchema.safeParse({ page_size: 101 }).success).toBe(false);
  });

  it('rejects unknown role values', () => {
    expect(listMessagesQuerySchema.safeParse({ role: 'critter' }).success).toBe(false);
  });
});

describe('listMessagesResponseSchema', () => {
  it('parses an empty page', () => {
    expect(listMessagesResponseSchema.parse({ items: [], has_more: false })).toEqual({
      items: [],
      has_more: false,
    });
  });

  it('parses a page with one message', () => {
    const parsed = listMessagesResponseSchema.parse({
      items: [
        {
          id: 'msg_01',
          session_id: 'sess_1',
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          created_at: '2026-06-04T10:30:00.000Z',
        },
      ],
      has_more: true,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.has_more).toBe(true);
  });
});

describe('getMessageResponseSchema', () => {
  it('parses a Message with optional fields', () => {
    const parsed = getMessageResponseSchema.parse({
      id: 'msg_01',
      session_id: 'sess_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      created_at: '2026-06-04T10:30:00.000Z',
      prompt_id: 'prompt_01',
    });
    expect(parsed.prompt_id).toBe('prompt_01');
  });
});
