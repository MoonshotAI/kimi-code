import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const PARTIAL = 'The first half of the answer';

selfTest('expectStopped', {
  positive: {
    'finds the mark of a turn the user stopped mid-reply': {
      run: async ({ product, model }) => {
        model.script(held('mid-reply', say([PARTIAL, ' and the rest.']), 1));
        await product.send('Answer slowly.');
        await model.hold('mid-reply').reached();
        await product.expectReply(PARTIAL);
        await product.stop();
        await product.waitIdle();
        model.hold('mid-reply').release();
        await product.expectStopped();
        expect(model.requests('main').map((request) => request.state)).toEqual(['aborted']);
      },
    },
  },
  negative: {
    'fails when the turn ended on its own': {
      run: async ({ product, model }) => {
        model.script(say('All done.'));
        await product.send('Finish a turn.');
        await product.waitIdle();
        await product.expectReply('All done.');
        await expect(product.expectStopped()).rejects.toThrow('ended without being stopped');
      },
    },
    'fails when an earlier turn was stopped but the latest one was not': {
      run: async ({ product, model }) => {
        model.script(held('mid-reply', say([PARTIAL, ' and the rest.']), 1), say('Second answer.'));
        await product.send('Answer slowly.');
        await model.hold('mid-reply').reached();
        await product.expectReply(PARTIAL);
        await product.stop();
        await product.waitIdle();
        model.hold('mid-reply').release();
        await product.send('Answer again.');
        await product.waitIdle();
        await product.expectReply('Second answer.');
        await expect(product.expectStopped()).rejects.toThrow('ended without being stopped');
      },
    },
  },
});
