import { bash, held, say, think } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const PROMPT = 'Draft the release notes.';
const STEERED = 'Use the release profile.';
const MARKER = "printf 'x\\n' > marker.txt";

selfTest('steer', {
  positive: {
    'reaches the model while it is writing its reply, which starts the request over': {
      run: async ({ product, model }) => {
        model.script(held('drafting', say(['Drafting the ', 'notes now.']), 1), say('Drafting them with the release profile.'));
        await product.send(PROMPT);
        await model.hold('drafting').reached();
        await product.steer(STEERED);
        await product.waitIdle();
        const requests = model.requests('main');
        expect(requests.map((request) => request.state)).toEqual(['aborted', 'finished']);
        expect(requests[1]?.userTextsSinceReply.at(-1)).toBe(STEERED);
        await product.expectReply('Drafting them with the release profile.');
      },
    },
    'reaches the model while it is thinking, which starts the request over': {
      run: async ({ product, model }) => {
        model.script(held('thinking', think(['Looking at the notes', ' from the last release']), 1), say('Drafting them with the release profile.'));
        await product.send(PROMPT);
        await model.hold('thinking').reached();
        await product.steer(STEERED);
        await product.waitIdle();
        const requests = model.requests('main');
        expect(requests.map((request) => request.state)).toEqual(['aborted', 'finished']);
        expect(requests[1]?.userTextsSinceReply.at(-1)).toBe(STEERED);
        await product.expectReply('Drafting them with the release profile.');
      },
    },
  },
  negative: {
    'fails when no turn is running': {
      run: async ({ product, model }) => {
        await expect(product.steer(STEERED)).rejects.toThrow('needs a running turn');
        model.script(say('Nothing was steered.'));
        await product.send(PROMPT);
        await product.waitIdle();
        await expect(product.steer(STEERED)).rejects.toThrow('needs a running turn');
        expect(model.requests('main').map((request) => request.userTextsSinceReply)).toEqual([[PROMPT]]);
        await product.expectReply('Nothing was steered.');
      },
    },
    'fails while an approval is pending': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(MARKER), say('I did not write it.'));
        await product.send('Write the marker.');
        await product.expectApproval({ name: 'Bash', target: MARKER });
        await expect(product.steer(STEERED)).rejects.toThrow('while an approval is pending');
        await product.reject();
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(2);
        expect(model.requests('main').flatMap((request) => request.texts('user')).join('\n')).not.toContain(STEERED);
        await product.expectTool({ name: 'Bash', target: MARKER, status: 'rejected' });
        await workspace.expectMissing('marker.txt');
      },
    },
    'fails while messages wait in the queue': {
      run: async ({ product, model }) => {
        const queued = 'Then answer this.';
        model.script(held('drafting', say(['Drafting the ', 'notes now.']), 1), say('Queued message answered.'));
        await product.send(PROMPT);
        await model.hold('drafting').reached();
        await product.queue(queued);
        await expect(product.steer(STEERED)).rejects.toThrow('needs an empty queue');
        model.hold('drafting').release();
        await product.waitIdle();
        const requests = model.requests('main');
        expect(requests.map((request) => request.state)).toEqual(['finished', 'finished']);
        expect(requests.map((request) => request.userTextsSinceReply)).toEqual([[PROMPT], [queued]]);
        await product.expectReply('Queued message answered.');
      },
    },
  },
});
