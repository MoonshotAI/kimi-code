import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('undo', {
  positive: {
    'withdraws the latest prompt with its reply and leaves the earlier turn': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'), say('The second answer, once more.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.undo();
        await product.expectComposer('Ask the second question.');
        await product.expectReply('The first answer.');
        await expect(product.expectTranscript('Ask the second question.')).rejects.toThrow('did not find');
        await expect(product.expectTranscript('The second answer.')).rejects.toThrow('did not find');
        await product.submit('Ask the second question.');
        await product.waitIdle();
        await product.expectReply('The second answer, once more.');
        const resent = model.requests('main')[2];
        expect(resent?.texts('user').filter((text) => text === 'Ask the second question.')).toHaveLength(1);
        expect(resent?.texts('assistant')).not.toContain('The second answer.');
      },
    },
  },
  negative: {
    'fails when there is no message to withdraw': {
      run: async ({ product }) => {
        await expect(product.undo()).rejects.toThrow('no user message');
        await product.expectComposer('');
      },
    },
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished after all.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.undo()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished after all.');
      },
    },
  },
});
