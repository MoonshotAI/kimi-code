import { describe, expect, it } from 'vitest';

import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
} from '../rest/prompt';

describe('promptSubmissionSchema', () => {
  it('accepts a minimal text-only submission with no controls', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(parsed.content[0]?.type).toBe('text');
    expect(parsed.model).toBeUndefined();
    expect(parsed.thinking).toBeUndefined();
    expect(parsed.permission_mode).toBeUndefined();
    expect(parsed.plan_mode).toBeUndefined();
  });

  it('accepts metadata', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [{ type: 'text', text: 'hi' }],
      metadata: { source: 'cli' },
    });
    expect(parsed.metadata).toEqual({ source: 'cli' });
  });

  it('accepts image + text mixed content', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [
        { type: 'text', text: 'see attached' },
        { type: 'image', source: { kind: 'url', url: 'https://a.png' } },
      ],
    });
    expect(parsed.content).toHaveLength(2);
  });

  it('accepts video + text mixed content', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [
        { type: 'text', text: 'describe this video' },
        { type: 'video', source: { kind: 'url', url: 'https://example.com/a.mp4' } },
      ],
    });
    expect(parsed.content).toHaveLength(2);
    expect(parsed.content[1]?.type).toBe('video');
  });

  it('accepts a partial per-turn override (model only)', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [{ type: 'text', text: 'hi' }],
      model: 'kimi-code/k2',
    });
    expect(parsed.model).toBe('kimi-code/k2');
    expect(parsed.thinking).toBeUndefined();
  });

  it('accepts the full bundle of controls when supplied', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [{ type: 'text', text: 'hi' }],
      model: 'kimi-code/k2',
      thinking: 'off',
      permission_mode: 'manual',
      plan_mode: false,
    });
    expect(parsed.model).toBe('kimi-code/k2');
    expect(parsed.thinking).toBe('off');
    expect(parsed.permission_mode).toBe('manual');
    expect(parsed.plan_mode).toBe(false);
  });

  it('rejects empty content array', () => {
    expect(
      promptSubmissionSchema.safeParse({
        content: [],
      }).success,
    ).toBe(false);
  });

  it('rejects missing content', () => {
    expect(promptSubmissionSchema.safeParse({} as unknown).success).toBe(false);
  });

  it('accepts any non-empty thinking effort (provider normalizes)', () => {
    expect(
      promptSubmissionSchema.safeParse({
        content: [{ type: 'text', text: 'hi' }],
        thinking: 'mega' as unknown,
      }).success,
    ).toBe(true);
  });

  it('rejects empty thinking effort', () => {
    expect(
      promptSubmissionSchema.safeParse({
        content: [{ type: 'text', text: 'hi' }],
        thinking: '' as unknown,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown permission_mode', () => {
    expect(
      promptSubmissionSchema.safeParse({
        content: [{ type: 'text', text: 'hi' }],
        permission_mode: 'unrestricted' as unknown,
      }).success,
    ).toBe(false);
  });

  it('rejects empty model string', () => {
    expect(
      promptSubmissionSchema.safeParse({
        content: [{ type: 'text', text: 'hi' }],
        model: '',
      }).success,
    ).toBe(false);
  });
});

describe('promptSubmitResultSchema', () => {
  it('parses a running prompt result shape', () => {
    const parsed = promptSubmitResultSchema.parse({
      prompt_id: 'prompt_01HZ',
      user_message_id: 'msg_sess_01_000000',
      status: 'running',
      content: [{ type: 'text', text: 'hi' }],
      created_at: '2026-06-09T00:00:00.000Z',
    });
    expect(parsed.prompt_id).toBe('prompt_01HZ');
    expect(parsed.status).toBe('running');
  });

  it('rejects empty prompt_id', () => {
    expect(
      promptSubmitResultSchema.safeParse({ prompt_id: '', user_message_id: 'msg' })
        .success,
    ).toBe(false);
  });
});

describe('promptListResponseSchema', () => {
  it('parses active and queued prompts', () => {
    const parsed = promptListResponseSchema.parse({
      active: {
        prompt_id: 'prompt_active',
        user_message_id: 'msg_active',
        status: 'running',
        content: [{ type: 'text', text: 'active' }],
        created_at: '2026-06-09T00:00:00.000Z',
      },
      queued: [
        {
          prompt_id: 'prompt_queued',
          user_message_id: 'msg_queued',
          status: 'queued',
          content: [{ type: 'text', text: 'queued' }],
          created_at: '2026-06-09T00:00:01.000Z',
        },
      ],
    });
    expect(parsed.active?.status).toBe('running');
    expect(parsed.queued[0]?.status).toBe('queued');
  });
});

describe('promptSteerRequestSchema', () => {
  it('requires at least one prompt id', () => {
    expect(promptSteerRequestSchema.parse({ prompt_ids: ['prompt_a'] }).prompt_ids)
      .toEqual(['prompt_a']);
    expect(promptSteerRequestSchema.safeParse({ prompt_ids: [] }).success).toBe(false);
  });
});

describe('promptSteerResultSchema', () => {
  it('parses steered prompt ids', () => {
    const parsed = promptSteerResultSchema.parse({
      steered: true,
      prompt_ids: ['prompt_a', 'prompt_b'],
    });
    expect(parsed.steered).toBe(true);
    expect(parsed.prompt_ids).toEqual(['prompt_a', 'prompt_b']);
  });
});

describe('promptAbortResponseSchema', () => {
  it('parses { aborted: true } success shape', () => {
    const parsed = promptAbortResponseSchema.parse({ aborted: true, at_seq: 7 });
    expect(parsed.aborted).toBe(true);
    expect(parsed.at_seq).toBe(7);
  });

  it('parses { aborted: false } idempotent shape (used with envelope.code=40903)', () => {
    const parsed = promptAbortResponseSchema.parse({ aborted: false });
    expect(parsed.aborted).toBe(false);
  });
});
