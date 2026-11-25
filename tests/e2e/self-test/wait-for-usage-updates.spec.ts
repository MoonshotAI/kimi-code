import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('waitForUsageUpdates', {
  positive: {
    'observes the usage update after a prompt finishes': {
      run: async ({ product, model }) => {
        model.script(say('Here is the answer.'));
        await product.send('Answer the question.');
        await product.waitIdle();
        await product.waitForUsageUpdates(1);
        await product.expectReply('Here is the answer.');
      },
    },
  },
  negative: {
    'rejects a count that the editor has already passed': {
      run: async ({ product, model }) => {
        model.script(say('Here is the answer.'));
        await product.send('Answer the question.');
        await product.waitIdle();
        await product.waitForUsageUpdates(1);
        await expect(product.waitForUsageUpdates(0)).rejects.toThrow('expected 0, received 1');
        await product.expectReply('Here is the answer.');
      },
    },
  },
});
