import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectSessions', {
  positive: {
    'finds every session in the workspace in any order': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.expectSessions(['Ask the first question.', 'Ask the second question.']);
        await product.expectSessions(['Ask the second question.', 'Ask the first question.']);
      },
    },
  },
  negative: {
    'fails when a session is missing from the list or the list has one more': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the second question.');
        await product.waitIdle();
        await expect(product.expectSessions(['Ask the first question.'])).rejects.toThrow('expectSessions() wanted');
        await expect(product.expectSessions(['Ask the first question.', 'Ask the second question.', 'Ask a third question.'])).rejects.toThrow('expectSessions() wanted');
        await product.expectReply('The second answer.');
      },
    },
  },
});
