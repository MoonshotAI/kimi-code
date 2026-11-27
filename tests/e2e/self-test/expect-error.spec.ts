import { held, httpError, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const REFUSED = 'The example service refused this request.';
const LONG_REFUSAL =
  'The example service refused this request because the example account has run out of the example quota for this example project, and it will refill at the start of the next example period.';

selfTest('expectError', {
  positive: {
    'finds the message of a request the model service refused': {
      run: async ({ product, model }) => {
        model.script(httpError(400, { message: REFUSED }));
        await product.send('Ask the model something.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.state)).toEqual(['failed']);
        await product.expectError(REFUSED);
      },
    },
    'finds the message of a key the model service did not accept': {
      run: async ({ product, model }) => {
        model.script(httpError(401, { message: 'The example key was not accepted.' }));
        await product.send('Ask with a bad key.');
        await product.waitIdle();
        await product.expectError('The example key was not accepted.');
      },
    },
    'finds a failure that comes after the turn already read a file and replied': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt', { text: 'Checking the file first.' }), httpError(400, { message: REFUSED }));
        await product.send('Read a.txt, then answer.');
        await product.waitIdle();
        await product.expectError(REFUSED);
        await product.expectReply('Checking the file first.');
      },
    },
    'finds a message too long for one line of the terminal': {
      run: async ({ product, model }) => {
        model.script(httpError(400, { message: LONG_REFUSAL }));
        await product.send('Ask for a long refusal.');
        await product.waitIdle();
        await product.expectError(LONG_REFUSAL);
      },
    },
    'waits for a running turn to fail': {
      run: async ({ product, model }) => {
        const order: string[] = [];
        model.script(held('refusal', httpError(400, { message: REFUSED })));
        await product.send('Ask and wait.');
        const checked = product.expectError(REFUSED).then(() => order.push('found'));
        await model.hold('refusal').reached();
        order.push('released');
        model.hold('refusal').release();
        await checked;
        expect(order).toEqual(['released', 'found']);
        await product.waitIdle();
      },
    },
  },
  negative: {
    'fails when the turn ended normally': {
      run: async ({ product, model }) => {
        model.script(say('Everything worked.'));
        await product.send('Answer normally.');
        await product.waitIdle();
        await expect(product.expectError('Everything worked.')).rejects.toThrow('found no failure');
        await product.expectReply('Everything worked.');
      },
    },
    'does not take a reply that quotes an error line for a failure': {
      run: async ({ product, model }) => {
        model.script(say('The log said:\n\nError: [example.code] the build broke.\n\nNothing failed in this turn.'));
        await product.send('Quote the log.');
        await product.waitIdle();
        await expect(product.expectError('the build broke.')).rejects.toThrow('found no failure');
        await product.expectReply('Nothing failed in this turn.');
      },
    },
    'fails when the turn failed with another message': {
      run: async ({ product, model }) => {
        model.script(httpError(400, { message: REFUSED }));
        await product.send('Ask the model something.');
        await product.waitIdle();
        await expect(product.expectError('A message nobody sent.')).rejects.toThrow('but not with "A message nobody sent."');
        await product.expectError(REFUSED);
      },
    },
    'does not take the failure of an earlier turn': {
      run: async ({ product, model }) => {
        model.script(httpError(400, { message: REFUSED }), say('Recovered.'));
        await product.send('Ask the model something.');
        await product.waitIdle();
        await product.send('Try again.');
        await product.waitIdle();
        await expect(product.expectError(REFUSED)).rejects.toThrow('found no failure');
        await product.expectReply('Recovered.');
      },
    },
  },
});
