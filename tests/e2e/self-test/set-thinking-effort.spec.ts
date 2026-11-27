import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const EFFORT_CHANGED = 'the user changed the thinking effort, which is part of the model settings';
const THINKING_MODEL = {
  config: {
    models: {
      testkit: {
        provider: 'testkit',
        model: 'testkit-model',
        maxContextSize: 262_144,
        capabilities: ['thinking'],
        extra: { support_efforts: ['low', 'high'], default_effort: 'low' },
      },
    },
  },
};

selfTest('setThinkingEffort', {
  positive: {
    'raises the effort in the middle of a session, so the next request asks for it': {
      ...THINKING_MODEL,
      run: async ({ product, model }) => {
        model.script(say('Thought a little.'), say('Thought hard.'));
        await product.send('Think a little.');
        await product.waitIdle();
        await product.setThinkingEffort('high');
        model.expectCacheBreak(EFFORT_CHANGED, { at: 'header' });
        await product.send('Think hard.');
        await product.waitIdle();
        await product.expectReply('Thought hard.');
        const [before, after] = model.requests('main');
        expect(before?.body).toMatchObject({ thinking: { type: 'enabled', effort: 'low' } });
        expect(after?.body).toMatchObject({ thinking: { type: 'enabled', effort: 'high' } });
      },
    },
    'turns thinking off': {
      ...THINKING_MODEL,
      run: async ({ product, model }) => {
        model.script(say('Thought a little.'), say('Did not think.'));
        await product.send('Think a little.');
        await product.waitIdle();
        await product.setThinkingEffort('off');
        model.expectCacheBreak(EFFORT_CHANGED, { at: 'header' });
        await product.send('Do not think.');
        await product.waitIdle();
        await product.expectReply('Did not think.');
        expect(model.requests('main')[1]?.body).toMatchObject({ thinking: { type: 'disabled' } });
      },
    },
  },
  negative: {
    'fails when the session already uses that effort': {
      ...THINKING_MODEL,
      run: async ({ product, model }) => {
        await expect(product.setThinkingEffort('low')).rejects.toThrow('already the thinking effort');
        model.script(say('Still thinking a little.'));
        await product.send('How hard do you think?');
        await product.waitIdle();
        await product.expectReply('Still thinking a little.');
        expect(model.requests('main')[0]?.body).toMatchObject({ thinking: { type: 'enabled', effort: 'low' } });
      },
    },
    'fails for an effort the model does not offer': {
      ...THINKING_MODEL,
      run: async ({ product, model }) => {
        await expect(product.setThinkingEffort('max')).rejects.toThrow('offers only');
        model.script(say('Still thinking a little.'));
        await product.send('How hard do you think?');
        await product.waitIdle();
        await product.expectReply('Still thinking a little.');
        expect(model.requests('main')[0]?.body).toMatchObject({ thinking: { type: 'enabled', effort: 'low' } });
      },
    },
    'fails while a turn is running': {
      ...THINKING_MODEL,
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished thinking a little.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.setThinkingEffort('high')).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished thinking a little.');
        expect(model.requests('main')[0]?.body).toMatchObject({ thinking: { type: 'enabled', effort: 'low' } });
      },
    },
  },
});
