import { describe, expect, it } from 'vitest';
import { ensureObjectRequiredArrays, toolToOpenAI } from '#/providers/openai-common';
import type { Tool } from '#/tool';

describe('toolToOpenAI schema compatibility', () => {
  it('forces missing required to [] on object tool parameters', () => {
    const tool: Tool = {
      name: 'demo',
      description: 'demo tool',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
      },
    };

    const converted = toolToOpenAI(tool);
    expect(converted.function.parameters).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: [],
    });
  });

  it('forces non-array required to []', () => {
    const tool: Tool = {
      name: 'demo',
      description: 'demo tool',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        // Invalid for Moonshot-flavored schema; some generators emit boolean-style required.
        required: true as unknown as string[],
      },
    };

    const converted = toolToOpenAI(tool);
    expect(converted.function.parameters?.['required']).toEqual([]);
  });

  it('preserves valid required arrays and nested object schemas', () => {
    const tool: Tool = {
      name: 'demo',
      description: 'demo tool',
      parameters: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
        required: ['nested'],
      },
    };

    const converted = toolToOpenAI(tool);
    expect(converted.function.parameters).toEqual({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: [],
        },
      },
      required: ['nested'],
    });
  });
});

describe('ensureObjectRequiredArrays', () => {
  it('returns undefined for undefined input', () => {
    expect(ensureObjectRequiredArrays(undefined)).toBeUndefined();
  });
});
