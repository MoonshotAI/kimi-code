import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('restart', {
  positive: {
    'reopens the same conversation and keeps it going': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.restart();
        await product.expectTranscript('Ask the first question.');
        await product.expectTranscript('The first answer.');
        expect(model.requests('main')).toHaveLength(1);
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.expectReply('The second answer.');
        expect(model.requests('main')[1]?.texts('user')).toContain('Ask the first question.');
      },
    },
    'reopens a product that has not had a turn yet': {
      run: async ({ product, model }) => {
        await product.restart();
        model.script(say('Hello after a quiet restart.'));
        await product.send('Say hello.');
        await product.waitIdle();
        await product.expectReply('Hello after a quiet restart.');
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished after all.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.restart()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished after all.');
      },
    },
    'does not let the latest-turn checks read the restored conversation': {
      run: async ({ product, model }) => {
        model.script(say('Before the restart.'));
        await product.send('Say something.');
        await product.waitIdle();
        await product.restart();
        await expect(product.expectReply('Before the restart.')).rejects.toThrow('expectTranscript()');
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' })).rejects.toThrow('expectTranscript()');
        await product.expectTranscript('Before the restart.');
      },
    },
  },
});
