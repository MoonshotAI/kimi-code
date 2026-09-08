import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { lowerMessage } from '#/llm/requester/bases/anthropic/lower';

function modelFor(provider: string): LlmModel {
  return { provider, model: 'test-model', capability: UNKNOWN_CAPABILITY };
}

const HEIC_URL = 'data:image/heic;base64,AAAA';

const message: Message = {
  role: 'user',
  content: [{ type: 'image_url', imageUrl: { url: HEIC_URL } }],
};

describe('anthropic lowering of inline images', () => {
  it('forwards a base64 image in a format the bound provider accepts', () => {
    const wire = lowerMessage(message, { trait: undefined, ctx: { model: modelFor('kimi') } });
    expect(wire[0]?.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', data: 'AAAA', media_type: 'image/heic' },
    });
  });

  it('refuses a base64 image outside the bound provider set before any request is sent', () => {
    expect(() =>
      lowerMessage(message, { trait: undefined, ctx: { model: modelFor('anthropic') } }),
    ).toThrow(/Unsupported media type for base64 image: image\/heic/);
  });
});
