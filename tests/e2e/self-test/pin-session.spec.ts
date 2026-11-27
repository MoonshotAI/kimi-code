import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('pinSession', {
  positive: {
    'pins the open conversation': {
      run: async ({ product, model }) => {
        model.script(say('Pin me.'));
        await product.send('Start a conversation worth keeping.');
        await product.waitIdle();
        await product.expectReply('Pin me.');
        await product.pinSession();
        await product.expectPinned();
        expect(model.requests('main')).toHaveLength(1);
      },
    },
  },
  negative: {
    'fails when the open conversation is already pinned': {
      run: async ({ product, model }) => {
        model.script(say('Already kept.'));
        await product.send('Start a conversation worth keeping.');
        await product.waitIdle();
        await product.expectReply('Already kept.');
        await product.pinSession();
        await expect(product.pinSession()).rejects.toThrow('already pinned');
        await product.expectPinned();
      },
    },
  },
});
