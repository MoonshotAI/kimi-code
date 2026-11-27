import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectPinned', {
  positive: {
    'passes for a conversation that stays pinned after a restart': {
      run: async ({ product, model }) => {
        model.script(say('Kept for later.'));
        await product.send('Keep this conversation.');
        await product.waitIdle();
        await product.expectReply('Kept for later.');
        await product.pinSession();
        await product.restart();
        await product.expectPinned();
        expect(model.requests('main')).toHaveLength(1);
      },
    },
  },
  negative: {
    'fails for a conversation nobody pinned': {
      run: async ({ product, model }) => {
        model.script(say('Not pinned.'));
        await product.send('Just talk.');
        await product.waitIdle();
        await product.expectReply('Not pinned.');
        await expect(product.expectPinned()).rejects.toThrow('not pinned');
      },
    },
  },
});
