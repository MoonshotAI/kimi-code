import { held, httpError, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const REFUSED = 'The example service refused this request.';

selfTest('continue', {
  positive: {
    'continues a failed turn without sending a user message': {
      run: async ({ product, model }) => {
        const prompt = 'Ask the model something.';
        model.script(httpError(400, { message: REFUSED }), say('Continued answer.'));
        await product.send(prompt);
        await product.waitIdle();
        await product.expectError(REFUSED);
        await product.continue();
        await product.waitIdle();
        const requests = model.requests('main');
        expect(requests.map((request) => request.state)).toEqual(['failed', 'finished']);
        expect(requests[1]?.userTextsSinceReply).toEqual([prompt]);
        await product.expectReply('Continued answer.');
      },
    },
  },
  negative: {
    'fails when the turn ended normally': {
      run: async ({ product, model }) => {
        model.script(say('All done.'));
        await product.send('Finish a turn.');
        await product.waitIdle();
        await expect(product.continue()).rejects.toThrow('found no failed turn');
        await product.expectReply('All done.');
        expect(model.requests('main')).toHaveLength(1);
      },
    },
    'fails after the user stopped the turn': {
      run: async ({ product, model }) => {
        model.script(held('mid', say(['Half of the answer ', 'and the rest.']), 1));
        await product.send('Start answering.');
        await model.hold('mid').reached();
        await product.expectReply('Half of the answer');
        await product.stop();
        await product.waitIdle();
        model.hold('mid').release();
        await expect(product.continue()).rejects.toThrow('found no failed turn');
        expect(model.requests('main').map((request) => request.state)).toEqual(['aborted']);
      },
    },
  },
});
