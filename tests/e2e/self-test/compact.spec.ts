import { held, httpError, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('compact', {
  positive: {
    'returns once the compaction has finished, so the next request carries the summary': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        model.lane('compaction').script(say('Summary: the user asked a first question.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.compact();
        expect(model.requests('compaction').map((request) => request.state)).toEqual(['finished']);
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.expectReply('The second answer.');
        expect(model.requests('main')[1]?.texts('user').some((text) => text.includes('Summary: the user asked a first question.'))).toBe(true);
      },
    },
  },
  negative: {
    'fails at once when the model service refuses to summarize': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'));
        model.lane('compaction').script(httpError(400, { message: 'The example service refused to summarize.' }));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.expectReply('The first answer.');
        await expect(product.compact()).rejects.toThrow('compact()');
        expect(model.requests('compaction')).toHaveLength(1);
      },
    },
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished before any compaction.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.compact()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished before any compaction.');
        expect(model.requests('compaction')).toHaveLength(0);
      },
    },
  },
});
