import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('newSession', {
  positive: {
    'starts a session that neither shows nor sends the earlier conversation': {
      run: async ({ product, model }) => {
        model.script(say('The earlier answer.'), say('The fresh answer.'));
        await product.send('Ask the earlier question.');
        await product.waitIdle();
        await product.newSession();
        await expect(product.expectTranscript('Ask the earlier question.')).rejects.toThrow('Ask the earlier question.');
        await product.send('Ask the fresh question.');
        await product.waitIdle();
        await product.expectReply('The fresh answer.');
        await product.expectTranscript('Ask the fresh question.');
        const fresh = model.requests('main')[1];
        expect(fresh?.texts('user')).toContain('Ask the fresh question.');
        expect(fresh?.texts('user').some((text) => text.includes('Ask the earlier question.'))).toBe(false);
      },
    },
    'starts one new session after another': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'), say('The third answer.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the third question.');
        await product.waitIdle();
        await product.expectReply('The third answer.');
        expect(model.requests('main')[2]?.texts('user').some((text) => text.includes('Ask the second question.'))).toBe(false);
      },
    },
    'starts a new session before the first message as well': {
      run: async ({ product, model }) => {
        await product.newSession();
        model.script(say('Hello from a new session.'));
        await product.send('Say hello.');
        await product.waitIdle();
        await product.expectReply('Hello from a new session.');
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished in the first session.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.newSession()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished in the first session.');
      },
    },
  },
});
