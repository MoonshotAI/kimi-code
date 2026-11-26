import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const OPENER = 'Start the conversation.';

selfTest('submit', {
  positive: {
    'sends the prompt recalled into the input': {
      run: async ({ product, model }) => {
        model.script(say('Started.'), say('First time.'), say('Second time.'));
        await product.send(OPENER);
        await product.waitIdle();
        await product.send('Say it twice.');
        await product.waitIdle();
        await product.recallPrevious();
        await product.submit('Say it twice.');
        await product.waitIdle();
        await product.expectReply('Second time.');
        await product.expectComposer('');
        expect(model.requests('main')[2]?.userTextsSinceReply).toEqual(['Say it twice.']);
      },
    },
    'sends the prompt that undo put back': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The answer again.'));
        await product.send('Answer this.');
        await product.waitIdle();
        await product.undo();
        model.expectCacheBreak('undo rewrites the history', { at: 'history' });
        await product.submit('Answer this.');
        await product.waitIdle();
        await product.expectReply('The answer again.');
        expect(model.requests('main')[1]?.texts('assistant')).not.toContain('The first answer.');
      },
    },
  },
  negative: {
    'fails when the input holds different text': {
      run: async ({ product, model }) => {
        model.script(say('Started.'), say('Once.'));
        await product.send(OPENER);
        await product.waitIdle();
        await product.send('The prompt in the input.');
        await product.waitIdle();
        await product.recallPrevious();
        await expect(product.submit('Some other prompt.')).rejects.toThrow('but it holds');
        await product.expectComposer('The prompt in the input.');
        expect(model.requests('main')).toHaveLength(2);
      },
    },
  },
});
