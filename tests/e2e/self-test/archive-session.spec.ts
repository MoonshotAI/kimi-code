import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('archiveSession', {
  positive: {
    'archives another session and leaves the open one as it was': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'), say('Still here.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.archiveSession('Ask the first question.');
        await product.expectSessions(['Ask the second question.']);
        await product.send('Are you still here?');
        await product.waitIdle();
        await product.expectReply('Still here.');
      },
    },
  },
  negative: {
    'fails for the open session and for a title no session has': {
      run: async ({ product, model }) => {
        model.script(say('The only answer.'));
        await product.send('Ask the only question.');
        await product.waitIdle();
        await expect(product.archiveSession('Ask the only question.')).rejects.toThrow('it is the open session');
        await expect(product.archiveSession('A title nobody wrote')).rejects.toThrow('no session has that title');
        await product.expectSessions(['Ask the only question.']);
      },
    },
  },
});
