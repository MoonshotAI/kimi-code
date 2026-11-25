import { httpError, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectNotice', {
  positive: {
    'finds retry progress in a live notice': {
      run: async ({ product, model }) => {
        model.script(
          httpError(503, { message: 'The example service is not ready yet.', retryAfterSeconds: 1 }),
          say('The project is on track.'),
        );
        await product.send('Summarise the project status.');
        await product.expectNotice('Model request failed; retrying (attempt 2)');
        await product.waitIdle();
        await product.expectNotice('The example service is not ready yet.');
        await product.expectReply('The project is on track.');
      },
    },
  },
  negative: {
    'fails when no live notice contains the text': {
      run: async ({ product, model }) => {
        model.script(say('The sky is blue.'));
        await product.send('What colour is the sky?');
        await product.waitIdle();
        await expect(product.expectNotice('The example service is not ready yet.')).rejects.toThrow('did not find');
        await product.expectReply('The sky is blue.');
      },
    },
  },
});
