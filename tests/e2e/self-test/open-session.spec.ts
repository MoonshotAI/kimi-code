import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('openSession', {
  positive: {
    'goes back to the earlier session, shows its conversation and continues it': {
      run: async ({ product, model }) => {
        model.script(say('The earlier answer.'), say('The later answer.'), say('Back in the earlier session.'));
        await product.send('Ask the earlier question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the later question.');
        await product.waitIdle();
        await product.openSession('Ask the earlier question.');
        await product.expectTranscript('Ask the earlier question.');
        await product.expectReply('The earlier answer.');
        await expect(product.expectTranscript('Ask the later question.')).rejects.toThrow('Ask the later question.');
        await product.send('Ask a follow-up question.');
        await product.waitIdle();
        await product.expectReply('Back in the earlier session.');
        const back = model.requests('main')[2];
        expect(back?.texts('user')).toContain('Ask the earlier question.');
        expect(back?.texts('assistant')).toContain('The earlier answer.');
        expect(back?.texts('user').some((text) => text.includes('Ask the later question.'))).toBe(false);
      },
    },
    'goes back to the later session as well': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'), say('More in the first session.'), say('More in the second session.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.openSession('Ask the first question.');
        await product.send('Follow up in the first session.');
        await product.waitIdle();
        await product.expectReply('More in the first session.');
        await product.openSession('Ask the second question.');
        await product.expectTranscript('The second answer.');
        await product.send('Follow up in the second session.');
        await product.waitIdle();
        await product.expectReply('More in the second session.');
        const last = model.requests('main')[3];
        expect(last?.texts('user')).toContain('Ask the second question.');
        expect(last?.texts('user').some((text) => text.includes('Ask the first question.') || text.includes('Follow up in the first session.'))).toBe(false);
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(say('The earlier answer.'), held('busy', say('Finished in the later session.'), 1));
        await product.send('Ask the earlier question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.openSession('Ask the earlier question.')).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished in the later session.');
      },
    },
    'fails for a title that no session has': {
      run: async ({ product, model }) => {
        model.script(say('The only answer.'));
        await product.send('Ask the only question.');
        await product.waitIdle();
        await expect(product.openSession('Ask a question nobody asked.')).rejects.toThrow('found no session titled "Ask a question nobody asked."');
        await product.expectReply('The only answer.');
      },
    },
    'fails for the session that is already open': {
      run: async ({ product, model }) => {
        model.script(say('The only answer.'));
        await product.send('Ask the only question.');
        await product.waitIdle();
        await expect(product.openSession('Ask the only question.')).rejects.toThrow('is the session already open');
        await product.expectReply('The only answer.');
      },
    },
  },
});
