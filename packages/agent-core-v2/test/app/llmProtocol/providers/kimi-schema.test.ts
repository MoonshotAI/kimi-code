import { describe, expect, it } from 'vitest';

import { normalizeKimiToolSchema } from '#/app/llmProtocol/providers/kimi-schema';

describe('normalizeKimiToolSchema', () => {
  it('removes required entries that have no matching property in the root schema', () => {
    const normalized = normalizeKimiToolSchema({
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path', 'missing'],
    });

    expect(normalized['required']).toEqual(['path']);
  });

  it('removes required entries that have no matching property in nested object schemas', () => {
    const normalized = normalizeKimiToolSchema({
      type: 'object',
      properties: {
        workFlow: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              codec: { type: 'string' },
            },
            required: ['codec', 'codecType'],
          },
        },
      },
    });

    expect(normalized).toMatchObject({
      properties: {
        workFlow: {
          items: {
            required: ['codec'],
          },
        },
      },
    });
  });

  it('removes required when none of its entries match the declared properties', () => {
    const normalized = normalizeKimiToolSchema({
      type: 'object',
      properties: {
        workFlow: {
          type: 'object',
          properties: {
            codec: { type: 'string' },
          },
          required: ['codecType'],
        },
      },
    });

    expect(normalized).toMatchObject({
      properties: {
        workFlow: {
          properties: {
            codec: { type: 'string' },
          },
        },
      },
    });
    const workFlow = (normalized['properties'] as Record<string, unknown>)['workFlow'];
    expect(workFlow).not.toHaveProperty('required');
  });

  it('preserves required when the schema declares no properties', () => {
    const normalized = normalizeKimiToolSchema({
      type: 'object',
      required: ['dynamicField'],
      additionalProperties: { type: 'string' },
    });

    expect(normalized['required']).toEqual(['dynamicField']);
  });
});
