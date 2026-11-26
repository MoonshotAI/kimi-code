import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const THINKING_MODEL = { capabilities: ['thinking'] } as const;

function thinkingOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'thinking' in body ? body.thinking : undefined;
}

selfTest('setThinking', {
  positive: {
    'turns thinking off for the next request': {
      provider: THINKING_MODEL,
      run: async ({ product, model }) => {
        model.script(say('Thought about it.'), say('Answered straight away.'));
        await product.send('Think it over.');
        await product.waitIdle();
        await product.setThinking('off');
        model.expectCacheBreak('the user turned thinking off', { at: 'header' });
        await product.send('Answer straight away.');
        await product.waitIdle();
        await product.expectReply('Answered straight away.');
        const [first, second] = model.requests('main');
        expect(thinkingOf(first?.body)).toMatchObject({ type: 'enabled' });
        expect(thinkingOf(second?.body)).toEqual({ type: 'disabled' });
      },
    },
  },
  negative: {
    'fails when the model offers no such level': {
      provider: THINKING_MODEL,
      run: async ({ product, model }) => {
        await expect(product.setThinking('max')).rejects.toThrow('max');
        model.script(say('Still thinking.'));
        await product.send('Answer.');
        await product.waitIdle();
        await product.expectReply('Still thinking.');
      },
    },
    'fails when that level is already set': {
      provider: THINKING_MODEL,
      run: async ({ product, model }) => {
        await expect(product.setThinking('on')).rejects.toThrow('already');
        model.script(say('Still thinking.'));
        await product.send('Answer.');
        await product.waitIdle();
        await product.expectReply('Still thinking.');
      },
    },
  },
});
