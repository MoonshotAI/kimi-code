import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('reopenOnAnotherPort', {
  positive: {
    'reopens the same conversation on another port and keeps it going': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.reopenOnAnotherPort();
        await product.expectTranscript('Ask the first question.');
        await product.expectReply('The first answer.');
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.expectReply('The second answer.');
        expect(model.requests('main')[1]?.texts('user')).toContain('Ask the first question.');
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished after all.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.reopenOnAnotherPort()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished after all.');
      },
    },
  },
});
