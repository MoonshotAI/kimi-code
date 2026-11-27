import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const PROMPT = 'Draft the release notes.';
const QUEUED = 'Use the release profile.';

selfTest('steerQueued', {
  positive: {
    'steers the queued message into the turn that is still writing': {
      run: async ({ product, model }) => {
        model.script(held('drafting', say(['Drafting the ', 'notes now.']), 1), say('Drafting them with the release profile.'));
        await product.send(PROMPT);
        await model.hold('drafting').reached();
        await product.queue(QUEUED);
        await product.steerQueued();
        await product.waitIdle();
        const requests = model.requests('main');
        expect(requests.map((request) => request.state)).toEqual(['aborted', 'finished']);
        expect(requests[1]?.userTextsSinceReply.at(-1)).toBe(QUEUED);
        await product.expectReply('Drafting them with the release profile.');
        await product.expectTranscript(QUEUED);
      },
    },
  },
  negative: {
    'fails when nothing waits in the queue': {
      run: async ({ product, model }) => {
        model.script(held('drafting', say(['Drafting the ', 'notes now.']), 1));
        await product.send(PROMPT);
        await model.hold('drafting').reached();
        await expect(product.steerQueued()).rejects.toThrow('needs exactly one message in the queue, but 0');
        model.hold('drafting').release();
        await product.waitIdle();
        await product.expectReply('notes now.');
      },
    },
    'fails when two messages wait in the queue': {
      run: async ({ product, model }) => {
        model.script(held('drafting', say(['Drafting the ', 'notes now.']), 1), say('First queued answer.'), say('Second queued answer.'));
        await product.send(PROMPT);
        await model.hold('drafting').reached();
        await product.queue('First queued message.');
        await product.queue('Second queued message.');
        await expect(product.steerQueued()).rejects.toThrow('needs exactly one message in the queue, but 2');
        model.hold('drafting').release();
        await product.waitIdle();
        await product.expectReply('Second queued answer.');
      },
    },
  },
});
