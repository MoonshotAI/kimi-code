import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const PROMPT = 'Start the first answer.';
const QUEUED = 'Then answer this.';
const MARKER = "printf 'x\\n' > marker.txt";

selfTest('queue', {
  positive: {
    'holds the message while the turn runs, then sends it as the next turn': {
      run: async ({ product, model }) => {
        model.script(held('first', say(['Working on the ', 'first answer.']), 1), say('Queued message answered.'));
        await product.send(PROMPT);
        await model.hold('first').reached();
        await product.queue(QUEUED);
        expect(model.requests('main')).toHaveLength(1);
        model.hold('first').release();
        await product.waitIdle();
        const requests = model.requests('main');
        expect(requests.map((request) => request.state)).toEqual(['finished', 'finished']);
        expect(requests.map((request) => request.userTextsSinceReply)).toEqual([[PROMPT], [QUEUED]]);
        await product.expectReply('Queued message answered.');
      },
    },
  },
  negative: {
    'fails when no turn is running': {
      run: async ({ product, model }) => {
        await expect(product.queue(QUEUED)).rejects.toThrow('needs a running turn');
        model.script(say('Nothing was queued.'));
        await product.send(PROMPT);
        await product.waitIdle();
        await expect(product.queue(QUEUED)).rejects.toThrow('needs a running turn');
        expect(model.requests('main').map((request) => request.userTextsSinceReply)).toEqual([[PROMPT]]);
        await product.expectReply('Nothing was queued.');
      },
    },
    'fails while an approval is pending': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(MARKER), say('I did not write it.'));
        await product.send('Write the marker.');
        await product.expectApproval({ name: 'Bash', target: MARKER });
        await expect(product.queue(QUEUED)).rejects.toThrow('while an approval is pending');
        await product.reject();
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(2);
        expect(model.requests('main').flatMap((request) => request.texts('user')).join('\n')).not.toContain(QUEUED);
        await product.expectTool({ name: 'Bash', target: MARKER, status: 'rejected' });
        await workspace.expectMissing('marker.txt');
      },
    },
    'fails on the terminal UI when the queue cuts the message short': {
      onlyOn: ['tui'],
      reason: 'Only the terminal UI cuts a queued message down to one line; Desktop and Web show it whole.',
      run: async ({ product, model }) => {
        const long = `Then answer this, ${'and keep going '.repeat(8)}until the end.`;
        model.script(held('first', say(['Working on the ', 'first answer.']), 1), say('Queued message answered.'));
        await product.send(PROMPT);
        await model.hold('first').reached();
        await expect(product.queue(long)).rejects.toThrow('cuts it short');
        model.hold('first').release();
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.userTextsSinceReply)).toEqual([[PROMPT], [long]]);
        await product.expectReply('Queued message answered.');
      },
    },
    'fails when the same message is already in the queue': {
      run: async ({ product, model }) => {
        model.script(held('first', say(['Working on the ', 'first answer.']), 1), say('Queued message answered.'));
        await product.send(PROMPT);
        await model.hold('first').reached();
        await product.queue(QUEUED);
        await expect(product.queue(QUEUED)).rejects.toThrow('already in the queue');
        model.hold('first').release();
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.userTextsSinceReply)).toEqual([[PROMPT], [QUEUED]]);
        await product.expectReply('Queued message answered.');
      },
    },
  },
});
