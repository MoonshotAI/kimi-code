import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const OPENER = 'Start the conversation.';

selfTest('recallPrevious', {
  positive: {
    'walks back through the earlier prompts, newest first': {
      run: async ({ product, model }) => {
        model.script(say('Started.'), say('First.'), say('Second.'));
        await product.send(OPENER);
        await product.waitIdle();
        await product.send('The older prompt.');
        await product.waitIdle();
        await product.send('The newer prompt.');
        await product.waitIdle();
        await product.recallPrevious();
        await product.expectComposer('The newer prompt.');
        await product.recallPrevious();
        await product.expectComposer('The older prompt.');
      },
    },
  },
  negative: {
    'fails when no prompt has been sent yet': {
      run: async ({ product }) => {
        await expect(product.recallPrevious()).rejects.toThrow('found no earlier prompt');
        await product.expectComposer('');
      },
    },
    'refuses to walk the history from text it did not recall': {
      run: async ({ product, model }) => {
        model.script(say('Started.'), say('Noted.'));
        await product.send(OPENER);
        await product.waitIdle();
        await product.send('The prompt that undo brings back.');
        await product.waitIdle();
        await product.undo();
        await expect(product.recallPrevious()).rejects.toThrow('needs an empty');
        await product.expectComposer('The prompt that undo brings back.');
      },
    },
  },
});
