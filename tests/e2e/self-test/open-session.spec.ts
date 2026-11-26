import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('openSession', {
  positive: {
    'opens another session by its title and continues it there': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'), say('Back in the first.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.openSession('Ask the first question.');
        await product.expectTranscript('The first answer.');
        await product.send('Continue the first.');
        await product.waitIdle();
        await product.expectReply('Back in the first.');
        const continued = model.requests('main')[2];
        expect(continued?.texts('assistant')).toEqual(['The first answer.']);
        expect(continued?.userTextsSinceReply).toEqual(['Continue the first.']);
      },
    },
  },
  negative: {
    'fails for the open session and for a title no session has': {
      run: async ({ product, model }) => {
        model.script(say('The only answer.'));
        await product.send('Ask the only question.');
        await product.waitIdle();
        await expect(product.openSession('Ask the only question.')).rejects.toThrow('no other session has that title');
        await expect(product.openSession('A title nobody wrote')).rejects.toThrow('no other session has that title');
        await product.expectReply('The only answer.');
      },
    },
  },
});
